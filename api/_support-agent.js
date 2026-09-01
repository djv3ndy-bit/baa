const clean = (value, max = 5000) => String(value ?? '').trim().slice(0, max);

const CATEGORY_BY_TYPE = {
  bug: 'technical',
  account: 'account',
  barista: 'marketplace',
  cafe: 'marketplace',
  billing: 'billing',
  feedback: 'feedback',
  question: 'general',
  other: 'other',
};

const HIGH_RISK = [
  /delete (my )?account/i,
  /remove (my )?(account|data|profile)/i,
  /refund/i,
  /chargeback/i,
  /fraud/i,
  /stolen card/i,
  /harass/i,
  /threat/i,
  /unsafe/i,
  /scam/i,
  /fake (account|profile)/i,
  /ban|suspend/i,
  /password|2fa|two.factor|security/i,
];

const CRITICAL = [
  /data breach|breach/i,
  /hacked|account takeover/i,
  /credit card (number|details)/i,
  /social security|ssn/i,
  /physical threat|death threat/i,
];

export function triageSupportTicket(ticket = {}) {
  const issueType = clean(ticket.issue_type, 60).toLowerCase();
  const subject = clean(ticket.subject, 180);
  const description = clean(ticket.description, 5000);
  const text = `${subject}\n${description}`;
  const category = CATEGORY_BY_TYPE[issueType] || 'other';

  const critical = CRITICAL.some((pattern) => pattern.test(text));
  const highRisk = critical || HIGH_RISK.some((pattern) => pattern.test(text));
  const technical = category === 'technical';
  const billing = category === 'billing';

  let priority = 'P3';
  let route = 'support';
  let approvalRequired = false;
  let reason = 'Standard support request.';

  if (critical) {
    priority = 'P0';
    route = 'owner';
    approvalRequired = true;
    reason = 'Potential security, privacy, payment-data, or physical-safety incident.';
  } else if (highRisk) {
    priority = 'P1';
    route = billing ? 'billing_owner' : 'owner';
    approvalRequired = true;
    reason = 'Sensitive account, billing, safety, moderation, or destructive action requested.';
  } else if (technical) {
    priority = 'P2';
    route = 'engineering';
    reason = 'Technical issue should be investigated by Engineering & Reliability.';
  } else if (billing) {
    priority = 'P2';
    route = 'billing';
    approvalRequired = true;
    reason = 'Billing questions may be investigated, but financial changes require owner approval.';
  } else if (['account', 'marketplace'].includes(category)) {
    priority = 'P2';
    reason = 'Account or marketplace request needs support review before any user-data change.';
  }

  return {
    version: 'support-triage-v1',
    category,
    priority,
    route,
    confidence: issueType in CATEGORY_BY_TYPE ? 0.9 : 0.65,
    approval_required: approvalRequired,
    autonomous_send_allowed: false,
    destructive_action_allowed: false,
    financial_action_allowed: false,
    production_write_allowed: false,
    reason,
  };
}

export function supportDraft(ticket = {}, triage = triageSupportTicket(ticket)) {
  const name = clean(ticket.name, 120);
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const ticketId = clean(ticket.ticket_id, 50);
  const reference = ticketId ? ` for ticket ${ticketId}` : '';

  if (triage.priority === 'P0' || triage.priority === 'P1') {
    return `${greeting}\n\nThanks for contacting BaristaMatch${reference}. Your request needs additional review by our team before any account, billing, safety, or security action is taken. We’ve flagged it for priority review and will follow up as soon as possible.\n\n— BaristaMatch Support`;
  }
  if (triage.route === 'engineering') {
    return `${greeting}\n\nThanks for reporting this${reference}. We’ve documented the issue and it needs a technical review. Our team will investigate before we confirm a fix or ask you to take additional steps.\n\n— BaristaMatch Support`;
  }
  if (triage.route === 'billing') {
    return `${greeting}\n\nThanks for reaching out about billing${reference}. We’ll review the subscription details before making any changes. No refund, charge, or subscription adjustment will be made automatically.\n\n— BaristaMatch Support`;
  }
  return `${greeting}\n\nThanks for contacting BaristaMatch${reference}. We’ve reviewed the details you provided and prepared your request for our support team. If we need any additional information, we’ll follow up with you.\n\n— BaristaMatch Support`;
}
