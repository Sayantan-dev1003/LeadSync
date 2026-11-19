import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireOwner } from '../middleware/auth.middleware';
import { sanitizeLogMessage } from '../lib/sanitizer';

const router = Router();

router.get('/', requireOwner, async (_req: Request, res: Response) => {
  try {
    const leads = await prisma.lead.findMany({
      orderBy: { importedAt: 'desc' },
      take: 50,
    });
    res.json({ leads });
  } catch (error) {
    const safeMsg = sanitizeLogMessage(error instanceof Error ? error.message : 'Database error');
    console.error('Failed to fetch leads:', safeMsg);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

export default router;
