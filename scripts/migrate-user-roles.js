// SEC-03 migration helper. Maps the old `admin|staff` role enum to the new
// four-role model.
//
// Default mapping:
//   admin -> owner   (the first admin account)  or  manager (others)
//   staff -> support
//
// Usage:
//   MONGO_URI=... node scripts/migrate-user-roles.js --dry-run
//   MONGO_URI=... node scripts/migrate-user-roles.js --apply
// Add --owner-email=foo@bar.com to force a specific user to owner.
//
// Read-only unless --apply is passed.

import 'dotenv/config';
import mongoose from 'mongoose';
import { User, ROLES } from '../src/models/User.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const dryRun = argv.includes('--dry-run') || !apply;
const ownerFlag = argv.find((a) => a.startsWith('--owner-email='));
const explicitOwner = ownerFlag ? ownerFlag.split('=')[1].toLowerCase().trim() : null;

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const users = await User.find({}).sort({ createdAt: 1 }).lean();
  const firstAdmin = users.find((u) => u.role === 'admin');
  const ownerEmail = explicitOwner || firstAdmin?.email || null;

  const plan = users
    .filter((u) => !ROLES.includes(u.role))
    .map((u) => {
      let next;
      if (u.email === ownerEmail) next = 'owner';
      else if (u.role === 'admin') next = 'manager';
      else if (u.role === 'staff') next = 'support';
      else next = 'support';
      return { _id: u._id, email: u.email, from: u.role, to: next };
    });

  console.log(`${users.length} user(s) total. ${plan.length} to migrate.`);
  for (const p of plan) console.log(`  ${p.email}: ${p.from} -> ${p.to}`);

  if (dryRun) {
    console.log('\nDry run. No writes. Re-run with --apply to commit.');
  } else {
    for (const p of plan) await User.updateOne({ _id: p._id }, { $set: { role: p.to } });
    console.log(`\nApplied. ${plan.length} user(s) updated.`);
  }
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
