
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';

// Update session activity at most once per minute.
const SESSION_ACTIVITY_INTERVAL = 60 * 1000;

// Generate JWT token.
export function signToken(user, sid) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      sid: sid || undefined,
    },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: config.jwtExpiresIn,
    }
  );
}

// Authentication middleware.
export async function requireAuth(req, res, next) {
  const startedAt = Date.now();

  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      error: 'Missing bearer token',
    });
  }

  let payload;

  // Verify JWT separately from database operations.
  try {
    payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
    });

    if (
      !payload ||
      typeof payload !== 'object' ||
      !payload.sub
    ) {
      return res.status(401).json({
        error: 'Invalid token',
      });
    }
  } catch (err) {
    return res.status(401).json({
      error:
        err.name === 'TokenExpiredError'
          ? 'Token expired'
          : 'Invalid token',
    });
  }

  try {
    // Customer tokens are validated downstream
    // by the existing requireCustomer middleware.
    if (payload.role !== 'customer') {
      const userStartedAt = Date.now();

      // Fetch only required user fields.
      const user = await User.findById(payload.sub)
        .select('disabled tokenInvalidBefore permissions role')
        .lean()
        .maxTimeMS(5000);

      console.log(
        `[auth] User lookup: ${Date.now() - userStartedAt}ms`
      );

      if (!user) {
        return res.status(401).json({
          error: 'User no longer exists',
        });
      }

      if (user.disabled) {
        return res.status(401).json({
          error: 'This account has been disabled',
        });
      }

      // Enforce token invalidation after password
      // resets or role changes.
      if (
        user.tokenInvalidBefore &&
        payload.iat &&
        payload.iat * 1000 <
          new Date(user.tokenInvalidBefore).getTime()
      ) {
        return res.status(401).json({
          error: 'Session ended, please sign in again',
        });
      }

      // Validate per-device session.
      if (payload.sid) {
        const sessionStartedAt = Date.now();

        const session = await Session.findOne({
          _id: payload.sid,
          uid: payload.sub,
        })
          .select('_id lastActiveAt')
          .lean()
          .maxTimeMS(5000);

        console.log(
          `[auth] Session lookup: ${
            Date.now() - sessionStartedAt
          }ms`
        );

        if (!session) {
          return res.status(401).json({
            error: 'Signed out on this device',
          });
        }

        const now = Date.now();

        const lastActiveAt = session.lastActiveAt
          ? new Date(session.lastActiveAt).getTime()
          : 0;

        // Avoid unnecessary database writes.
        if (
          !lastActiveAt ||
          now - lastActiveAt >= SESSION_ACTIVITY_INTERVAL
        ) {
          try {
            await Session.updateOne(
              {
                _id: payload.sid,
                uid: payload.sub,
                $or: [
                  {
                    lastActiveAt: {
                      $lte: new Date(
                        now - SESSION_ACTIVITY_INTERVAL
                      ),
                    },
                  },
                  {
                    lastActiveAt: { $exists: false },
                  },
                  {
                    lastActiveAt: null,
                  },
                ],
              },
              {
                $set: {
                  lastActiveAt: new Date(now),
                },
              }
            ).maxTimeMS(2000);
          } catch (err) {
            // Activity tracking failure must not
            // invalidate an otherwise valid session.
            console.warn(
              '[auth] Session activity update failed:',
              err.message
            );
          }
        }
      }

      // Use current permissions from the database.
      payload.permissions = Array.isArray(user.permissions)
        ? user.permissions
        : [];

      // Use the current database role.
      payload.role = user.role || payload.role;
    }

    req.user = payload;

    // Sliding-window JWT refresh.
    const now = Math.floor(Date.now() / 1000);

    if (
      payload.exp &&
      payload.exp - now < config.jwtRefreshThresholdSec
    ) {
      const refreshedToken = signToken(
        {
          _id: payload.sub,
          email: payload.email,
          role: payload.role,
        },
        payload.sid
      );

      res.setHeader(
        'X-Refreshed-Token',
        refreshedToken
      );
    }

    console.log(
      `[auth] ${req.method} ${req.path} completed in ${
        Date.now() - startedAt
      }ms`
    );

    return next();

  } catch (err) {
    console.error('[auth] Authentication error:', {
      name: err.name,
      message: err.message,
      path: req.path,
      duration: Date.now() - startedAt,
    });

    if (err.name === 'CastError') {
      return res.status(401).json({
        error: 'Invalid token',
      });
    }

    // Database outages must not be treated
    // as invalid authentication tokens.
    return res.status(503).json({
      error: 'Authentication service temporarily unavailable',
    });
  }
}

// Role-based authorization middleware.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Not authenticated',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Not allowed',
      });
    }

    return next();
  };
}
