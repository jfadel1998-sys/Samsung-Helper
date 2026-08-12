/**
 * Labeled corpus for the §7.1 prefilter (M4 acceptance: keep >=95% of
 * genuinely actionable mail).
 *
 * `label` is the ground truth a human would assign:
 *   'actionable' — Jason would want this in the brief
 *   'noise'      — it should not reach extraction
 *
 * The set is deliberately adversarial in both directions: actionable mail that
 * trips generic bulk heuristics (a supplier on a mailing-list platform, a
 * fabricator whose mail is auto-generated) and noise that superficially looks
 * like project mail (a newsletter about slabs, an invoice-shaped phish).
 */
import type { PrefilterInput } from '../../src/prefilter';

export interface LabeledMessage {
  id: string;
  label: 'actionable' | 'noise';
  note: string;
  input: PrefilterInput;
  /** Thread already contains an owner message. */
  threadHasOwnerMessage?: boolean;
}

const OWNER = 'jason@traxtone.com';
const MOET = 'moet@traxtone.com';

function msg(
  id: string,
  label: LabeledMessage['label'],
  note: string,
  over: {
    from?: string | null;
    subject?: string | null;
    body?: string | null;
    to?: string[];
    cc?: string[];
    listUnsubscribe?: boolean;
    autoSubmitted?: boolean;
    categories?: string[];
    isFromOwner?: boolean;
    emptyBody?: boolean;
    headersAvailable?: boolean;
    threadHasOwnerMessage?: boolean;
  },
): LabeledMessage {
  const body = over.body ?? 'body text';
  return {
    id,
    label,
    note,
    ...(over.threadHasOwnerMessage ? { threadHasOwnerMessage: true } : {}),
    input: {
      actorHandle: over.from === undefined ? 'someone@example.com' : over.from,
      subject: over.subject ?? null,
      bodyExcerpt: body,
      isFromOwner: over.isFromOwner ?? false,
      signals: {
        listUnsubscribe: over.listUnsubscribe ?? false,
        autoSubmitted: over.autoSubmitted ?? false,
        categories: over.categories ?? [],
        toAddresses: over.to ?? [OWNER],
        ccAddresses: over.cc ?? [],
        emptyBody: over.emptyBody ?? body.length === 0,
        headersAvailable: over.headersAvailable ?? true,
      },
    },
  };
}

// ── Actionable: allowlisted counterparties ────────────────────────────────
const counterpartyMail: LabeledMessage[] = [
  msg('sup-pricing', 'actionable', 'supplier confirms revised pricing', {
    from: 'm.rossi@example-supplier.it',
    subject: '2269.2 GVR Local Stone — revised pricing',
    body: 'Revised pricing attached for the 12 line items. FOB Livorno unchanged. Lead time now 6-8 weeks from PO.',
  }),
  msg('sup-fob', 'actionable', 'supplier asks a blocking question', {
    from: 'm.rossi@example-supplier.it',
    subject: 'RE: 2269.2 GVR — FOB clarification',
    body: 'The quote says FOB Livorno but the proforma says ex-works Carrara. Which is correct? We cannot release the PO until this is settled.',
  }),
  msg('fwd-vessel', 'actionable', 'forwarder reports a vessel change', {
    from: 'ops@example-forwarder.com',
    subject: 'Vessel change — Genoa sailing',
    body: 'The Genoa sailing has been rolled to Aug 22. Container MSCU1234567 is affected. Please advise on the crane window.',
  }),
  msg('fwd-customs', 'actionable', 'customs docs needed', {
    from: 'docs@example-forwarder.com',
    subject: 'Customs docs required — container MSCU1234567',
    body: 'We need the commercial invoice and packing list to clear customs. ETA Long Beach Aug 22.',
  }),
  msg('fab-template', 'actionable', 'fabricator schedules templating', {
    from: 'shop@example-fabricator.com',
    subject: 'Templating window — tower 2',
    body: 'We can template tower 2 the week of the 14th. Confirm the slabs will be on site by then.',
  }),
  msg('fab-breakage', 'actionable', 'quality issue on arrival', {
    from: 'shop@vegas-stoneworks-example.com',
    subject: 'Breakage on bundle 4',
    body: 'Three slabs in bundle 4 arrived cracked. Photos attached. Do you want replacements from the same lot or a credit?',
  }),
  msg('gc-schedule', 'actionable', 'GC schedule pressure', {
    from: 'pm@example-gc.com',
    subject: 'Stone install schedule — 2269.2',
    body: 'We need stone install to start Sep 8 to hold the CO date. Can you confirm delivery?',
  }),
  msg('gc-punch', 'actionable', 'GC punch list', {
    from: 'super@mccarthy-example-build.com',
    subject: 'Punch list items — lobby',
    body: 'Four punch list items on the lobby floor. Grout color mismatch at the elevator lobby.',
  }),
  msg('des-selection', 'actionable', 'designer changes a selection', {
    from: 'studio@example-design.studio',
    subject: 'Finish change — honed instead of polished',
    body: 'Client wants honed instead of polished for the spa. Does this change lead time?',
  }),
  msg('client-budget', 'actionable', 'client asks about cost impact', {
    from: 'dev@example-resort-group.com',
    subject: 'Cost impact of the finish change',
    body: 'What is the cost impact of moving to honed? We need a number before Friday.',
  }),
  msg('agent-address', 'actionable', 'allowlisted by exact address, not domain', {
    from: 't.nickolas@independent-agent-example.net',
    subject: 'Quarry block availability',
    body: 'Block 7741 is still available at the quarry. Holding it until Thursday.',
  }),
  msg('sup-es', 'actionable', 'Spanish supplier, non-ASCII body', {
    from: 'jose@example-supplier.es',
    subject: 'Génova — cambio de buque',
    body: 'Naïve façade slabs — 12 crates. Señor Muñoz confirmó el envío.',
  }),
  msg('quarry-lot', 'actionable', 'quarry reserves a lot', {
    from: 'sales@carrara-quarry-example.it',
    subject: 'Lot reservation',
    body: 'We are holding lot 4412 for you until the end of the month.',
  }),
  msg('shipping-bl', 'actionable', 'bill of lading issued', {
    from: 'bl@genoa-shipping-example.it',
    subject: 'B/L issued',
    body: 'Bill of lading issued for the Genoa sailing. Original documents couriered today.',
  }),
];

// ── Actionable but adversarial: trips a generic heuristic ─────────────────
const adversarialActionable: LabeledMessage[] = [
  msg('sup-via-list', 'actionable', 'supplier sends via a mailing-list platform (List-Unsubscribe set)', {
    from: 'm.rossi@example-supplier.it',
    subject: 'Price list update affecting 2269.2',
    body: 'Our Q4 price list changes the quartzite you specified on 2269.2. Current quote honored until Sep 1.',
    listUnsubscribe: true,
  }),
  msg('fab-automated', 'actionable', 'fabricator ticket system sets Auto-Submitted', {
    from: 'shop@example-fabricator.com',
    subject: 'Shop drawing ready for approval — 2269.2',
    body: 'Shop drawings for 2269.2 are ready for your approval. Fabrication cannot start until approved.',
    autoSubmitted: true,
  }),
  msg('gc-cc-only', 'actionable', 'owner only on Cc but a real GC request', {
    from: 'pm@example-gc.com',
    subject: 'Slab delivery sequence',
    body: 'Sequencing slabs by floor. Need confirmation of the delivery order.',
    to: ['super@mccarthy-example-build.com'],
    cc: [OWNER],
  }),
  msg('sup-promo-category', 'actionable', 'Gmail miscategorized a supplier as Promotions', {
    from: 'm.rossi@example-supplier.it',
    subject: 'Container booking confirmed',
    body: 'Container booking confirmed for the Genoa sailing.',
    categories: ['CATEGORY_PROMOTIONS'],
  }),
  msg('unknown-job-ref', 'actionable', 'unknown sender but a clear job reference', {
    from: 'newcontact@unknown-vendor-example.com',
    subject: 'Quote request 2269.2',
    body: 'Following up on the slab quote for job 2269.2. Can you send current pricing on the porcelain?',
  }),
  msg('unknown-job-body', 'actionable', 'job number appears only in the body, near stone words', {
    from: 'someone@unfamiliar-example.com',
    subject: 'Following up',
    body: 'Circling back on the marble for project 2269.2 — the quarry needs a decision on the lot this week.',
  }),
  msg('owner-thread-reply', 'actionable', 'owner not addressed but replied earlier in thread', {
    from: 'thirdparty@unknown-example.com',
    subject: 'RE: crane window',
    body: 'Confirming the crane window moved to Thursday.',
    to: ['someone-else@example.com'],
    threadHasOwnerMessage: true,
  }),
  msg('moet-internal', 'actionable', 'internal from Moet', {
    from: MOET,
    subject: 'Supplier still has not replied',
    body: 'The forwarder has not answered on the FOB question since Tuesday. Want me to escalate?',
  }),
  msg('owner-sent', 'actionable', 'owner-sent message keeps thread continuity', {
    from: OWNER,
    subject: 'RE: vessel change',
    body: 'Confirming receipt, will advise on the crane window.',
    isFromOwner: true,
    to: ['ops@example-forwarder.com'],
  }),
  msg('no-subject-actionable', 'actionable', 'no subject, real forwarder content', {
    from: 'ops@example-forwarder.com',
    subject: null,
    body: 'Vessel changed. Genoa now Aug 22.',
  }),
  msg('headers-missing', 'actionable', 'Graph omitted headers; must not be read as clean', {
    from: 'pm@example-gc.com',
    subject: 'Submittal returned',
    body: 'Submittal returned as revise-and-resubmit. See markups.',
    headersAvailable: false,
  }),
  msg('payment-dispute', 'actionable', 'payment dispute from a real supplier', {
    from: 'ar@example-supplier.it',
    subject: 'Overdue invoice — 2269.2',
    body: 'Invoice 88213 for 2269.2 is 45 days past due. We are holding the next shipment.',
  }),
];

// ── Noise ─────────────────────────────────────────────────────────────────
const moreActionable: LabeledMessage[] = [
  msg('sup-sample', 'actionable', 'sample request turnaround', {
    from: 'samples@example-supplier.it',
    subject: 'Sample set shipped',
    body: 'Three honed travertine samples shipped today, tracking attached. Confirm receipt so we can hold the lot.',
  }),
  msg('fwd-demurrage', 'actionable', 'demurrage risk, time-critical', {
    from: 'ops@example-forwarder.com',
    subject: 'Demurrage starting Friday — MSCU1234567',
    body: 'Free time expires Friday. Demurrage accrues at $185/day after that. We need the delivery order today.',
  }),
  msg('gc-co', 'actionable', 'change order needing pricing', {
    from: 'pm@example-gc.com',
    subject: 'Change order 14 — added quartzite at bar',
    body: 'Owner added quartzite at the bar top. Need pricing and lead time impact by Wednesday.',
  }),
  msg('des-submittal', 'actionable', 'submittal rejected', {
    from: 'studio@example-design.studio',
    subject: 'Submittal rejected — vein match',
    body: 'Vein match on the feature wall does not follow the approved layout. Please resubmit shop drawings.',
  }),
  msg('internal-moet-2', 'actionable', 'internal handoff needing owner decision', {
    from: MOET,
    subject: 'Two suppliers quoting the same scope',
    body: 'Both Carrara and the Spanish quarry quoted 2269.2. Need your call on which to award.',
  }),
  msg('unknown-vessel', 'actionable', 'unknown sender with a container reference', {
    from: 'dispatch@unfamiliar-carrier-example.com',
    subject: 'Container MSCU1234567 available for pickup',
    body: 'Your container is available for pickup at the Long Beach terminal.',
  }),
];

const newsletters: LabeledMessage[] = [
  'Stone World Weekly',
  'Surfaces Magazine',
  'Architectural Digest Pro',
  'Construction Dive',
  'Tile Today',
  'Countertop Business Monthly',
].map((title, i) =>
  msg(`news-${i}`, 'noise', `industry newsletter: ${title}`, {
    from: `newsletter@${title.toLowerCase().replace(/[^a-z]/g, '')}-example.com`,
    subject: `${title}: 8 trends in porcelain slabs this quarter`,
    body: 'This week in stone surfaces: trends, product launches, and an interview with a fabricator.',
    listUnsubscribe: true,
  }),
);

const promos: LabeledMessage[] = [
  'Tool Depot',
  'Vegas Office Supply',
  'FleetFuel Cards',
  'SaaS Analytics Co',
  'Trade Show Expo',
].map((v, i) =>
  msg(`promo-${i}`, 'noise', `marketing blast: ${v}`, {
    from: `deals@${v.toLowerCase().replace(/[^a-z]/g, '')}-example.com`,
    subject: `${v}: 40% off this week only`,
    body: 'Limited time offer. Shop now and save on tools and equipment.',
    listUnsubscribe: true,
    categories: ['CATEGORY_PROMOTIONS'],
  }),
);

const socialNotices: LabeledMessage[] = [
  ['linkedin.com', 'You have 7 new profile views'],
  ['facebookmail.com', 'Traxtone has a new page follower'],
  ['linkedin.com', 'Congratulate Maria on her work anniversary'],
].map(([domain, subject], i) =>
  msg(`social-${i}`, 'noise', `social notification from ${domain}`, {
    from: `notifications@${domain}`,
    subject: subject!,
    body: 'View on the web.',
    categories: ['CATEGORY_SOCIAL'],
  }),
);

const systemNotices: LabeledMessage[] = [
  ['noreply@calendar.google.com', 'Invitation: Site walk @ Tue Aug 12', ''],
  ['noreply@docusign.net', 'Completed: Subcontract agreement', 'Your document has been completed.'],
  ['no-reply@atlassian.net', 'JIRA: TRX-441 was updated', 'Issue updated by automation.'],
  ['notifications@slack.com', 'New message in #field-ops', 'You have unread messages.'],
  ['no-reply@zoom.us', 'Your cloud recording is ready', 'Recording available for 30 days.'],
  ['noreply@quickbooks-example.com', 'Your invoice was viewed', 'Automated accounting notice.'],
  ['automated@sendgrid.net', 'Delivery report', 'Automated delivery report.'],
].map(([from, subject, body], i) =>
  msg(`sys-${i}`, 'noise', `system notification: ${from}`, {
    from: from!,
    subject: subject!,
    body: body!,
    emptyBody: body === '',
    autoSubmitted: true,
  }),
);

const bouncesAndOoo: LabeledMessage[] = [
  msg('bounce-1', 'noise', 'hard bounce', {
    from: 'mailer-daemon@example-supplier.it',
    subject: 'Undelivered Mail Returned to Sender',
    body: 'The following address failed permanently.',
    autoSubmitted: true,
  }),
  msg('ooo-1', 'noise', 'out of office auto-reply', {
    from: 'assistant@example-gc.com',
    subject: 'Automatic reply: 2269.2 GVR',
    body: 'I am out of the office until Aug 20 with limited access to email.',
    autoSubmitted: true,
  }),
  msg('ooo-2', 'noise', 'auto-reply from a supplier address', {
    from: 'sales@carrara-quarry-example.it',
    subject: 'Automatic reply: chiuso per ferie',
    body: 'Our offices are closed for the August holidays.',
    autoSubmitted: true,
  }),
  msg('bounce-2', 'noise', 'postmaster delay warning', {
    from: 'postmaster@example-forwarder.com',
    subject: 'Delivery delayed',
    body: 'Delivery to the following recipient has been delayed.',
    autoSubmitted: true,
  }),
];

const broadcast: LabeledMessage[] = [
  msg('bcast-1', 'noise', 'owner not addressed, no thread history', {
    from: 'announcements@some-association-example.org',
    subject: 'Association bylaws update',
    body: 'Please review the updated bylaws at your convenience.',
    to: ['members@some-association-example.org'],
  }),
  msg('bcast-2', 'noise', 'blind broadcast to a large list', {
    from: 'events@trade-body-example.org',
    subject: 'Registration now open',
    body: 'Registration for the annual conference is now open.',
    to: ['undisclosed-recipients@trade-body-example.org'],
  }),
  msg('bcast-3', 'noise', 'vendor prospecting, owner not addressed', {
    from: 'sales@crm-vendor-example.com',
    subject: 'Quick question',
    body: 'Are you the right person to talk to about your CRM?',
    to: ['info@traxtone.com'],
  }),
  msg('bcast-4', 'noise', 'recruiter spam', {
    from: 'recruiter@staffing-example.com',
    subject: 'Estimators available now',
    body: 'We have several estimators available for immediate placement.',
    to: ['hiring@traxtone.com'],
  }),
  msg('bcast-5', 'noise', 'cold outreach with no project reference', {
    from: 'bd@logistics-vendor-example.com',
    subject: 'Reduce your freight spend',
    body: 'We help importers reduce freight spend by up to 30%. Worth a chat?',
    to: ['contact@traxtone.com'],
  }),
];

const lookalikes: LabeledMessage[] = [
  msg('look-1', 'noise', 'newsletter that mentions slabs but is not addressed to owner', {
    from: 'digest@stone-trends-example.com',
    subject: 'Porcelain slab market report',
    body: 'Slab prices rose 4% this quarter across European quarries.',
    listUnsubscribe: true,
    to: ['subscribers@stone-trends-example.com'],
  }),
  msg('look-2', 'noise', 'invoice-shaped phish from an unrelated domain', {
    from: 'billing@secure-invoice-portal-example.biz',
    subject: 'Invoice 4471 overdue — immediate action',
    body: 'Your invoice is overdue. Click the secure portal link to settle immediately.',
    to: ['accounts@traxtone.com'],
  }),
  msg('look-3', 'noise', 'four-digit year, no stone context', {
    from: 'hr@payroll-vendor-example.com',
    subject: 'Your 2026 benefits enrollment',
    body: 'Open enrollment for 2026 closes on the 30th.',
    listUnsubscribe: true,
  }),
  msg('look-4', 'noise', 'four-digit amount, no stone context', {
    from: 'noreply@bank-example.com',
    subject: 'Payment of 4500 posted',
    body: 'A payment of 4500 has posted to your account.',
    autoSubmitted: true,
  }),
  msg('look-5', 'noise', 'calendar invite with no body', {
    from: 'noreply@calendar.google.com',
    subject: 'Site walk — GVR tower 2',
    body: '',
    emptyBody: true,
    autoSubmitted: true,
  }),
];

const misc: LabeledMessage[] = Array.from({ length: 18 }, (_, i) =>
  msg(`misc-${i}`, 'noise', 'routine vendor/service notification', {
    from: `noreply@service${i}-example.com`,
    subject: `Your monthly statement is ready (${i})`,
    body: 'Your statement is available in the portal.',
    autoSubmitted: true,
    listUnsubscribe: i % 2 === 0,
  }),
);

// Routine SaaS and vendor mail that is addressed to the owner and carries no
// demotion header — the hardest noise class, and the one that decides whether
// the volume cut is real.
const softwareNotices: LabeledMessage[] = [
  ['Your trial expires in 3 days', 'trials@pm-tool-example.com'],
  ['Weekly usage summary', 'reports@fleet-example.com'],
  ['Password changed successfully', 'security@vendor-example.com'],
  ['New device signed in', 'security@storage-example.com'],
  ['Your subscription renews Sep 1', 'billing@design-tool-example.com'],
  ['Survey: how are we doing?', 'feedback@vendor-example.com'],
  ['Webinar tomorrow: scaling operations', 'events@webinar-example.com'],
  ['Your receipt from Rideshare', 'receipts@rideshare-example.com'],
  ['Flight check-in is open', 'checkin@airline-example.com'],
  ['Your order has shipped', 'orders@officesupply-example.com'],
  ['Monthly report is ready', 'reports@accounting-example.com'],
  ['Action needed: verify your email', 'verify@saas-example.com'],
].map(([subject, from], i) =>
  msg(`soft-${i}`, 'noise', `routine SaaS mail: ${subject}`, {
    from: from!,
    subject: subject!,
    body: 'Sign in to view details.',
    listUnsubscribe: true,
  }),
);

const moreBroadcast: LabeledMessage[] = [
  msg('bcast-6', 'noise', 'industry association blast', {
    from: 'news@industry-body-example.org',
    subject: 'Quarterly tile import statistics',
    body: 'Import volumes for tile and slab rose this quarter.',
    listUnsubscribe: true,
    to: ['members@industry-body-example.org'],
  }),
  msg('bcast-7', 'noise', 'unaddressed cold pitch mentioning stone', {
    from: 'sales@marble-vendor-example.com',
    subject: 'Premium marble at wholesale',
    body: 'We supply premium marble and granite at wholesale prices.',
    to: ['purchasing@traxtone.com'],
  }),
  msg('bcast-8', 'noise', 'city permit newsletter', {
    from: 'noreply@city-permits-example.gov',
    subject: 'Permit office holiday hours',
    body: 'The permit office will be closed Monday.',
    autoSubmitted: true,
    to: ['contractors@city-permits-example.gov'],
  }),
  msg('bcast-9', 'noise', 'insurance renewal blast', {
    from: 'noreply@insurance-example.com',
    subject: 'Your policy documents are available',
    body: 'Policy documents are available in your portal.',
    autoSubmitted: true,
  }),
  msg('bcast-10', 'noise', 'equipment rental promo mentioning install', {
    from: 'deals@rental-example.com',
    subject: 'Install equipment rentals — spring rates',
    body: 'Lift and install equipment available at spring rates.',
    listUnsubscribe: true,
  }),
];

export const CORPUS: LabeledMessage[] = [
  ...counterpartyMail,
  ...adversarialActionable,
  ...moreActionable,
  ...newsletters,
  ...promos,
  ...socialNotices,
  ...systemNotices,
  ...bouncesAndOoo,
  ...broadcast,
  ...lookalikes,
  ...misc,
  ...softwareNotices,
  ...moreBroadcast,
];

export const OWNER_EMAILS = [OWNER, MOET];
