import { OFFICES, RULES } from './config.js';
import { ClaimsService } from './services/claimsService.js';
import { RefillService } from './services/refillService.js';
import { ReportService } from './services/reportService.js';
import { VolunteerService } from './services/volunteerService.js';

/**
 * Wiring (the "composition root"). Real or fake adapters are passed in, and
 * the services never know which ones they got. Tests and the demo pass fakes.
 * Production would pass a Slack client, the HR vendor client and a Postgres
 * store.
 */
export function createApp({ store, chat, hr, clock, offices = OFFICES, rules = RULES }) {
  const claims = new ClaimsService({ store, chat, hr, clock, offices, rules });
  const refills = new RefillService({ store, chat, clock, claims, offices, rules });
  const volunteers = new VolunteerService({ store, offices });
  const reports = new ReportService({ store, chat, offices });

  /**
   * Called by a cron job (every 5 minutes, say). Each job is safe to run
   * twice and safe to run late, so a missed or doubled run does no harm.
   */
  async function runScheduledJobs() {
    await refills.checkTimeouts();
    await claims.retryFailedSubmissions();
    await claims.syncStatuses();
  }

  return { refills, claims, volunteers, reports, runScheduledJobs };
}
