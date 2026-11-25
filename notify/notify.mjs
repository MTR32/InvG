// Runs on GitHub Actions. Reads Firebase, sends push notifications, remembers what it sent.
import admin from 'firebase-admin';
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa),
  databaseURL: 'https://investgroup-5f2f9-default-rtdb.firebaseio.com' });
const db = admin.database();
const LOAN_HOUR_UTC = +(process.env.LOAN_HOUR_UTC ?? 6);
const OVERDUE_EVERY_DAYS = +(process.env.OVERDUE_EVERY_DAYS ?? 3);
const LOAN_EVERY_DAYS = +(process.env.LOAN_EVERY_DAYS ?? 7);
const DIGEST_HOUR_UTC = +(process.env.DIGEST_HOUR_UTC ?? 6);
const WEEKLY_DIGEST = (process.env.WEEKLY_DIGEST ?? 'on') !== 'off';
const APP_URL = process.env.APP_URL || './';

const get = async p => (await db.ref(p).once('value')).val();
const arr = v => Array.isArray(v) ? v.filter(Boolean) : Object.values(v || {});
const now = new Date(), todayStr = now.toISOString().slice(0, 10);

const GD = await get('investgroup');
if (!GD) { console.log('No group data'); process.exit(0); }
const tokensAll = (await get('fcmTokens')) || {};
const cur = (GD.settings && GD.settings.currency) || '';
const fmt = n => cur + Number(n).toLocaleString('en', { maximumFractionDigits: 2 });
const members = arr(GD.members);
const allLoans = arr(GD.loans).filter(l => !l.writtenOff);
const bal = l => Math.max(0, l.amount + l.amount * l.rate / 100 - (l.repaid || 0));
const loansOf = m => allLoans.filter(l => l.borrowerMemberId
  ? l.borrowerMemberId === m.id
  : l.borrower && l.borrower.trim().toLowerCase() === m.name.trim().toLowerCase());
function loanSummary(m) {
  const open = loansOf(m).filter(l => bal(l) > 0.01);
  const total = open.reduce((s, l) => s + bal(l), 0);
  const od = open.filter(l => l.dueDate && l.dueDate < todayStr).reduce((s, l) => s + bal(l), 0);
  const next = open.map(l => l.dueDate).filter(d => d && d >= todayStr).sort()[0] || null;
  return { open, total, od, next };
}

async function send(memberId, title, body, tag) {
  const entries = Object.keys(tokensAll[memberId] || {});
  if (!entries.length) { console.log('no token for member', memberId); return 0; }
  const res = await admin.messaging().sendEachForMulticast({
    tokens: entries,
    data: { title, body, tag: tag || '', url: APP_URL },
    webpush: { headers: { Urgency: 'high', TTL: String(60 * 60 * 24 * 3) } }
  });
  console.log('sent to', memberId, 'tokens:', entries.length, 'ok:', res.successCount);
  const dead = [];
  res.responses.forEach((r, i) => {
    if (r.error) console.log('FCM error', r.error.code, r.error.message);
    const c = r.error && r.error.code;
    if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') dead.push(entries[i]);
  });
  for (const t of dead) { console.log('removing dead token for', memberId); await db.ref(`fcmTokens/${memberId}/${t}`).remove(); }
  return res.successCount;
}

// 1. Manual messages typed in the treasurer app
const outbox = (await get('outbox')) || {};
for (const [id, m] of Object.entries(outbox)) {
  if (m.sentAt) continue;
  const ids = m.to === 'all' || !m.to ? members.map(x => x.id) : [].concat(m.to);
  let n = 0;
  for (const mid of ids) n += await send(mid, m.title || 'Message from your treasurer', m.body || '', 'msg-' + id);
  await db.ref('outbox/' + id).update({ sentAt: now.toISOString(), delivered: n });
  console.log('outbox', id, '->', n);
}

// 2. Deposits and loan payments (sent after the treasurer syncs)
const state = (await get('notifyState')) || {};
const seen = state.seenTx || {};
const repayRe = /^repayment\s*[\u2014\u2013-]\s*(.+)$/i;     // "Repayment — Borrower Name"
const isDeposit = t => t.type === 'contribution' && t.memberId && t.notes !== 'Initial';
function repaymentMember(t) {
  if (t.type !== 'loan_repayment' || t.isAutoRepay) return null;   // auto-repayments are not announced
  const mt = repayRe.exec((t.desc || '').trim());
  if (!mt) return null;
  const name = mt[1].trim().toLowerCase();
  const loan = arr(GD.loans).find(x => (x.borrower || '').trim().toLowerCase() === name);
  if (loan && loan.borrowerMemberId) return loan.borrowerMemberId;
  const m = members.find(x => x.name.trim().toLowerCase() === name);
  return m ? m.id : null;
}
const payments = [];
for (const t of arr(GD.transactions)) {
  if (isDeposit(t)) payments.push({ t, kind: 'dep', mid: t.memberId });
  else { const mid = repaymentMember(t); if (mid) payments.push({ t, kind: 'rep', mid }); }
}
if (!state.initialized || !state.paymentsBaselined) {            // first run: do not announce history
  const base = { ...seen }; payments.forEach(x => base[x.t.id] = true);
  await db.ref('notifyState').update({ initialized: true, paymentsBaselined: true, seenTx: base });
  console.log('baseline set', payments.length);
} else {
  const fresh = payments.filter(x => !seen[x.t.id]);
  const byMember = {};
  fresh.forEach(x => (byMember[x.mid] = byMember[x.mid] || []).push(x));
  for (const [mid, list] of Object.entries(byMember)) {
    const m = members.find(x => x.id === mid);
    const sum = k => list.filter(x => x.kind === k).reduce((s, x) => s + (+x.t.amount || 0), 0);
    const dep = sum('dep'), rep = sum('rep');
    const parts = [];
    if (dep > 0) parts.push(`Thank you! We received your deposit of ${fmt(dep)}.`);
    if (rep > 0) parts.push(`Thank you for your loan payment of ${fmt(rep)}.`);
    const ls = m ? loanSummary(m) : { open: [], total: 0, od: 0, next: null };
    if (ls.open.length) {
      parts.push(`Your remaining loan balance is ${fmt(ls.total)}${ls.od > 0.01 ? ` (${fmt(ls.od)} overdue)` : ''}${ls.next ? `, next due ${ls.next}` : ''}.`);
      parts.push(ls.od > 0.01 ? 'Please clear the overdue amount as soon as possible.' : 'Please complete it on time.');
    } else if (rep > 0) {
      parts.push('Your loans are fully cleared. Congratulations!');
    }
    const title = dep > 0 && rep > 0 ? 'Payments received' : rep > 0 ? 'Loan payment received' : 'Deposit received';
    const n = await send(mid, title, parts.join(' '), 'pay-' + mid);
    if (n && ls.open.length) {                                      // this message already shows the loan balance
      await db.ref('notifyState/loanReminded/' + mid).set(todayStr);
      state.loanReminded = state.loanReminded || {}; state.loanReminded[mid] = todayStr;
    }
  }
  const upd = {}; fresh.forEach(x => upd[x.t.id] = true);
  if (fresh.length) await db.ref('notifyState/seenTx').update(upd);
  console.log('payments announced', fresh.length);
}

// 2b. Saturday weekly summary (debt + what was earned this week). Turn off with WEEKLY_DIGEST: 'off'
if (WEEKLY_DIGEST && now.getUTCDay() === 6 && now.getUTCHours() >= DIGEST_HOUR_UTC) {
  const sent = state.weeklyDigest || {};
  const weekAgo = new Date(now - 7 * 864e5).toISOString().slice(0, 10);
  for (const m of members) {
    if (sent[m.id] === todayStr) continue;
    const ls = loanSummary(m);
    const earned = arr(GD.transactions).filter(t => t.type === 'profit' && t.memberId === m.id && t.date > weekAgo && t.date <= todayStr).reduce((s, t) => s + (+t.amount || 0), 0);
    if (ls.total <= 0.01 && earned <= 0) continue;
    const parts = [];
    if (ls.total > 0.01) parts.push(`Loan balance: ${fmt(ls.total)}${ls.od > 0.01 ? ` (${fmt(ls.od)} overdue)` : ''}.`);
    if (earned > 0) parts.push(`Earned this week: ${fmt(earned)}.`);
    const n = await send(m.id, 'Your weekly summary', parts.join(' '), 'weekly-' + m.id);
    if (n) {
      await db.ref('notifyState/weeklyDigest/' + m.id).set(todayStr);
      await db.ref('notifyState/loanReminded/' + m.id).set(todayStr);
      state.loanReminded = state.loanReminded || {}; state.loanReminded[m.id] = todayStr;
    }
  }
}

// 3. Loan reminders (automatic)
if (now.getUTCHours() >= LOAN_HOUR_UTC) {
  const reminded = state.loanReminded || {};
  for (const m of members) {
    const ls = loanSummary(m);
    if (!ls.open.length) continue;
    const overdue = ls.od > 0.01;
    const gap = overdue ? OVERDUE_EVERY_DAYS : LOAN_EVERY_DAYS;
    const last = reminded[m.id];
    if (last && (new Date(todayStr) - new Date(last)) / 864e5 < gap) continue;
    let body = `Your total loan balance is ${fmt(ls.total)}.`;
    if (overdue) {
      const oldest = ls.open.filter(l => l.dueDate && l.dueDate < todayStr).map(l => l.dueDate).sort()[0];
      body += ` ${fmt(ls.od)} is overdue (oldest due ${oldest}). Please make a repayment.`;
    } else if (ls.next) body += ` Next due date: ${ls.next}.`;
    const n = await send(m.id, overdue ? 'Loan overdue' : 'Loan reminder', body, 'loan-' + m.id);
    if (n) await db.ref('notifyState/loanReminded/' + m.id).set(todayStr);
  }
}
console.log('done');
process.exit(0);
