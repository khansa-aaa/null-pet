// Actions that always need the user's approval, even in auto mode.
// The list covers production, deploys, migrations, access rules, secrets, deletes, pushes, sends
// and destructive git/file commands.
const RISK = new RegExp(
  [
    '\\bprod(uction)?\\b',
    '\\bmigrations?\\b',
    '\\bmigrat(e|ing)\\b',
    '\\brls\\b',
    '\\bpolic(y|ies)\\b',
    '\\bsingpass\\b',
    '\\bsecrets?\\b',
    '\\bdelet\\w*\\b.*\\b(accounts?|users?|data|rows?|tables?|branch(es)?|files?)\\b',
    '\\bdrop (table|database|schema|column)\\b',
    '\\bdeploy\\w*\\b',
    '\\btestflight\\b',
    '\\bplay (alpha|store|console)\\b',
    '\\bbeta review\\b',
    '\\bsubmit\\w* (it |the build |the release )?(for|to) (review|beta|the store|apple|google)\\b',
    '\\brelease\\b',
    '\\boutreach\\b',
    '\\bsend\\w* (the |an? |all )?(emails?|messages?|dms?|invites?|newsletters?|campaigns?)\\b',
    '\\bemail (them|the|all|users?|customers?|partners?|venues?)\\b',
    '\\bgit push\\b',
    '\\bpush\\w* (to )?(origin|main|master|remote)\\b',
    '\\bforce[- ]push\\b',
    '\\breset --hard\\b',
    '\\brm -rf?\\b',
    '\\bpublish\\w*\\b',
    '\\bpayments?\\b',
    '\\bbilling\\b'
  ].join('|'),
  'i'
);

// Returns a reason string when the action is risky, or null.
function riskOf(action) {
  if (action.risky) return action.risk_reason || 'marked risky by the planner';
  const m = RISK.exec(`${action.title || ''}\n${action.prompt || ''}`);
  return m ? `mentions “${m[0]}”` : null;
}

module.exports = { riskOf, RISK };
