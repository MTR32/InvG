// Runs on GitHub Actions. Reads Firebase, sends push notifications, remembers what it sent.
import admin from 'firebase-admin';
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa),
  databaseURL: 'https://investgroup-5f2f9-default-rtdb.firebaseio.com' });
const db = admin.database();
const LOAN_HOUR_UTC = +(process.env.LOAN_HOUR_UTC ?? 6);
const OVERDUE_EVERY_DAYS = +(process.env.OVERDUE_EVERY_DAYS ?? 3);
const LOAN_EVERY_DAYS = +(process.env.LOAN_EVERY_DAYS ?? 7);
const APP_URL = process.env.APP_URL || './';

const get = async p => (await db.ref(p).once('value')).val();
const arr = v => Array.isArray(v) ? v.filter(Boolean) : Object.values(v || {});
const now = new Date(), todayStr = now.toISOString().slice(0, 10);

const GD = await get('investgroup');
if (!GD) { console.log('No group data'); process.exit(0); }
const tokensAll = (await get('fcmTokens')) || {};
const cur = (GD.settings && GD.settings.currency) || '';
const fmt = n => cur + Number(n).toLocaleString('en', { maximumFractionDigits: 2 });

async function send(memberId, title, body, tag) {
  const entries = Object.keys(tokensAll[memberId] || {});
      if (!entries.length) { console.log('no token for member', memberId); return 0; }
  const res = await admin.messaging().sendEachForMulticast({
    tokens: entries,
    data: { title, body, tag: tag || '', url: APP_URL },
    webpush: { headers: { Urgency: 'high', TTL: String(60 * 60 * 24 * 3) } }
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    const c = r.error && r.error.code;
    if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') dead.push(entries[i]);
  });
  for (const t of dead) await db.ref(`fcmTokens/${memberId}/${t}`).remove();
  return res.successCount;
}

// 1. Manual messages typed in the treasurer app
const outbox = (await get('outbox')) || {};
for (const [id, m] of Object.entries(outbox)) {
  if (m.sentAt) continue;
  const ids = m.to === 'all' || !m.to ? arr(GD.members).map(x => x.id) : [].concat(m.to);
  let n = 0;
  for (const mid of ids) n += await send(mid, m.title || 'Message from your treasurer', m.body || '', 'msg-' + id);
  await db.ref('outbox/' + id).update({ sentAt: now.toISOString(), delivered: n });
  console.log('outbox', id, '->', n);
}

// 2. New contributions (any source)
const state = (await get('notifyState')) || {};
const seen = state.seenTx || {};
const txs = arr(GD.transactions).filter(t => t.type === 'contribution' && t.memberId);
if (!state.initialized) {
  const base = {}; txs.forEach(t => base[t.id] = true);
  await db.ref('notifyState').update({ initialized: true, seenTx: base });
  console.log('baseline set', txs.length);
} else {
  const fresh = txs.filter(t => !seen[t.id]);
  const byMember = {};
  fresh.forEach(t => (byMember[t.memberId] = byMember[t.memberId] || []).push(t));
  for (const [mid, list] of Object.entries(byMember)) {
    const total = list.reduce((s, t) => s + (+t.amount || 0), 0);
    const body = list.length === 1
      ? `${fmt(total)} was added to your account${list[0].desc ? ' - ' + list[0].desc : ''}.`
      : `${list.length} contributions totalling ${fmt(total)} were added to your account.`;
    await send(mid, 'Contribution received', body, 'contrib-' + mid);
  }
  const upd = {}; fresh.forEach(t => upd[t.id] = true);
  if (fresh.length) await db.ref('notifyState/seenTx').update(upd);
  console.log('contributions announced', fresh.length);
}

// 3. Loan reminders (automatic)
if (now.getUTCHours() >= LOAN_HOUR_UTC) {
  const loans = arr(GD.loans).filter(l => !l.writtenOff);
  const bal = l => Math.max(0, l.amount + l.amount * l.rate / 100 - (l.repaid || 0));
  const mine = m => loans.filter(l => l.borrowerMemberId
    ? l.borrowerMemberId === m.id
    : l.borrower && l.borrower.trim().toLowerCase() === m.name.trim().toLowerCase());
  const reminded = state.loanReminded || {};
  for (const m of arr(GD.members)) {
    const open = mine(m).filter(l => bal(l) > 0.01);
    if (!open.length) continue;
    const overdue = open.filter(l => l.dueDate && l.dueDate < todayStr);
    const gap = overdue.length ? OVERDUE_EVERY_DAYS : LOAN_EVERY_DAYS;
    const last = reminded[m.id];
    if (last && (new Date(todayStr) - new Date(last)) / 864e5 < gap) continue;
    const total = open.reduce((s, l) => s + bal(l), 0);
    const od = overdue.reduce((s, l) => s + bal(l), 0);
    let body = `Your total loan balance is ${fmt(total)}.`;
    if (overdue.length) {
      const oldest = overdue.map(l => l.dueDate).sort()[0];
      body += ` ${fmt(od)} is overdue (oldest due ${oldest}). Please make a repayment.`;
    } else {
      const next = open.map(l => l.dueDate).filter(Boolean).sort()[0];
      if (next) body += ` Next due date: ${next}.`;
    }
    const n = await send(m.id, overdue.length ? 'Loan overdue' : 'Loan reminder', body, 'loan-' + m.id);
    if (n) await db.ref('notifyState/loanReminded/' + m.id).set(todayStr);
  }
}
console.log('done');
process.exit(0);
