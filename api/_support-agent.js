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


const BUSINESS_SENDERS = [
  { pattern: /stripe\.com$/i, category: 'billing_ops', route: 'billing' },
  { pattern: /accounts\.google\.com$|google\.com$/i, category: 'security_ops', route: 'security' },
  { pattern: /instagram\.com$|tiktok\.com$/i, category: 'social_ops', route: 'social' },
  { pattern: /sunbiz\.dos\.fl\.gov$/i, category: 'business_admin', route: 'owner' },
];

export function triageBusinessInboxEmail(email = {}) {
  const from = clean(email.from || email.from_, 240).toLowerCase();
  const subject = clean(email.subject, 240);
  const snippet = clean(email.snippet || email.body, 2000);
  const text = `${subject}\n${snippet}`;
  const senderDomain = (from.match(/@([^>\s]+)/)?.[1] || '').replace(/[>,;].*$/, '');
  const provider = BUSINESS_SENDERS.find(item => item.pattern.test(senderDomain));
  const supportLike = /support ticket|help|can't log|cannot log|login|account|application|apply|job post|café|cafe|barista/i.test(text);
  const security = /security alert|unrecognized device|new sign-in|new login|hacked|breach|account takeover/i.test(text);
  const billing = /stripe|payment|payout|invoice|subscription|refund|charge|webhook|tax id/i.test(text);
  const routine = /verification code|6-digit code|tips for|recap|newsletter|getting started/i.test(text);

  let category = provider?.category || (supportLike ? 'customer_support' : 'other');
  let route = provider?.route || (supportLike ? 'support' : 'owner');
  let priority = 'P3';
  let approvalRequired = false;
  let notifyOwner = false;

  if (security) { category='security_ops'; route='security'; priority='P1'; approvalRequired=true; notifyOwner=true; }
  else if (billing) { category='billing_ops'; route='billing'; priority=/action required|delivery issues|failed|paused|declined/i.test(text)?'P1':'P2'; approvalRequired=true; notifyOwner=priority==='P1'; }
  else if (supportLike) { priority='P2'; notifyOwner=true; }
  if (routine && !security && !/action required/i.test(text)) notifyOwner=false;

  return Object.freeze({
    version:'support-inbox-v2', category, route, priority,
    notify_owner:notifyOwner, approval_required:approvalRequired,
    autonomous_send_allowed:false, email_write_allowed:false,
    destructive_action_allowed:false, financial_action_allowed:false,
    production_write_allowed:false,
    safe_for_private_notion_summary:true,
  });
}

export function privateEscalationSummary(email = {}, triage = triageBusinessInboxEmail(email)) {
  const subject = clean(email.subject, 180) || 'No subject';
  return {
    task: `Inbox: ${subject}`,
    agent: 'Customer Support Agent',
    area: triage.route === 'billing' ? 'Payments' : triage.route === 'security' ? 'Security' : triage.route === 'support' ? 'Support' : 'Email',
    priority: triage.priority === 'P0' ? 'Critical' : triage.priority === 'P1' ? 'High' : triage.priority === 'P2' ? 'Medium' : 'Low',
    owner_approval_required: triage.approval_required,
    summary: `Private inbox triage: ${triage.category}; route=${triage.route}; priority=${triage.priority}. No email or external action was sent automatically.`,
  };
}
