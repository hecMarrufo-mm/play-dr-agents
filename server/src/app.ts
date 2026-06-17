import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import { requireAuth } from './auth/middleware';
import { errorHandler, notFoundHandler } from './middleware/error';
import authRoutes from './auth/routes';
import agentsRoutes from './modules/agents/routes';
import messagesRoutes from './modules/messages/routes';
import messagesGlobalRoutes from './modules/messages/global';
import filesRoutes from './modules/files/routes';
import usersRoutes from './modules/users/routes';
import modelsRoutes from './modules/models/routes';
import toolsRoutes from './modules/tools/routes';
import adminRoutes from './modules/admin/routes';

export function createApp() {
  const app = express();
  // Cloud Run terminates TLS at the proxy; trust it so `secure` cookies work.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  // Public health check for Cloud Run / load balancers.
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Public OAuth handshake (the only unauthenticated app routes).
  app.use('/api/auth', authRoutes);

  // Everything else under /api requires a valid session.
  const api = express.Router();
  api.use(requireAuth);
  api.use('/agents/:agentId/messages', messagesRoutes);
  api.use('/messages', messagesGlobalRoutes);
  api.use('/agents', agentsRoutes);
  api.use('/files', filesRoutes);
  api.use('/users', usersRoutes);
  api.use('/models', modelsRoutes);
  api.use('/tools', toolsRoutes);
  api.use('/admin', adminRoutes);
  app.use('/api', api);

  // Unmatched API routes → JSON 404 (never fall through to the SPA).
  app.use('/api', notFoundHandler);

  // Serve the built SPA and support client-side routing (production / built mode).
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
