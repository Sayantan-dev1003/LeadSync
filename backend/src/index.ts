import 'dotenv/config';
import 'express-async-errors';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { authenticate, verifyCsrf } from './middleware/auth.middleware';
import { sanitizeLogMessage } from './lib/sanitizer';
import authRouter from './routes/auth.route';
import parseRouter from './routes/parse.route';
import extractRouter from './routes/extract.route';
import importsRouter from './routes/imports.route';
import leadsRouter from './routes/leads.route';

const app = express();
const PORT = process.env.PORT || 4000;

// --- CORS Middleware ---
app.use(cors({
  origin: [
    process.env.APP_ORIGIN || 'http://localhost:3000',
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://groweasy-frontend.vercel.app',
  ],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- CSRF & Authentication Middleware ---
app.use(verifyCsrf);
app.use(authenticate);

// --- Health check ---
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Routes ---
app.use('/api/auth', authRouter);
app.use('/api/parse', parseRouter);
app.use('/api/extract', extractRouter);
app.use('/api/imports', importsRouter);
app.use('/api/leads', leadsRouter);

// --- Global error handler ---
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const safeMsg = sanitizeLogMessage(err.message);
  console.error('Unhandled error:', safeMsg);

  if (err.message === 'Only CSV files are accepted') {
    res.status(415).json({ error: err.message });
    return;
  }

  if (err.message.includes('File too large')) {
    res.status(413).json({ error: 'File exceeds the 5MB size limit' });
    return;
  }

  // Never expose stack traces or raw details to the client
  res.status(500).json({ error: 'An internal server error occurred' });
});

// --- 404 handler ---
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 LeadSync Backend running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Model: ${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}`);
});

export default app;
