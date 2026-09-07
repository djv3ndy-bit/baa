import { floridaPlaceParts } from './floridaLocation';
import type { MarketJob } from './marketplace';
export type JobDraft = { title: string; address1: string; address2: string; city: string; state: string; postalCode: string; hourlyPay: string; maximumPay: string; skills: string; description: string };
export const blankJobDraft: JobDraft = { title: '', address1: '', address2: '', city: '', state: 'FL', postalCode: '', hourlyPay: '', maximumPay: '', skills: '', description: '' };
export function draftFromJob(job: MarketJob): JobDraft {
  const legacy = floridaPlaceParts(job.location);
  return { title: job.title || '', address1: job.address_line1 || '', address2: job.address_line2 || '', city: job.city || legacy.city, state: job.state || 'FL', postalCode: job.postal_code || legacy.postal, hourlyPay: job.pay_min == null ? '' : String(job.pay_min), maximumPay: job.pay_max == null ? '' : String(job.pay_max), skills: (job.required_skills || []).join(', '), description: job.description || '' };
}
export function jobPayload(draft: JobDraft, schedules: string[], ownerId: string) {
  const pay = Number(draft.hourlyPay), maximum = draft.maximumPay.trim() ? Number(draft.maximumPay) : null;
  if (!draft.title.trim() || !draft.address1.trim() || !draft.city.trim() || !draft.description.trim() || !schedules.some(value => value.trim()) || !Number.isFinite(pay) || pay <= 0) throw new Error('Add the title, address, hourly pay, schedule, and description.');
  if (draft.state.trim().toUpperCase() !== 'FL') throw new Error('BaristaMatch currently supports jobs in Florida.');
  if (!/^\d{5}(?:-\d{4})?$/.test(draft.postalCode.trim())) throw new Error('Enter a valid ZIP code, such as 33101.');
  if (maximum !== null && (!Number.isFinite(maximum) || maximum < pay)) throw new Error('Maximum hourly pay must be at least the minimum.');
  return { owner_id: ownerId, title: draft.title.trim(), location: `${draft.city.trim()}, FL ${draft.postalCode.trim()}`, address_line1: draft.address1.trim(), address_line2: draft.address2.trim() || null, city: draft.city.trim(), state: 'FL', postal_code: draft.postalCode.trim(), pay_min: pay, pay_max: maximum, schedule: schedules.map(value => value.trim()).filter(Boolean).join(' · '), required_skills: draft.skills.split(',').map(value => value.trim()).filter(Boolean), description: draft.description.trim(), updated_at: new Date().toISOString() };
}
