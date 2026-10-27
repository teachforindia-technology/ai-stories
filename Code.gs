/**
 * AI Stories – Teach For India
 * One Apps Script web app, two tabs:
 *   1. Share your reflection (Vertical Heads submit / edit stories)
 *   2. Get inspired (approved stories from all verticals; locked until the AIWC threshold is met)
 *
 * SETUP (container-bound script):
 *   1. Create a Google Sheet > Extensions > Apps Script. Paste Code.gs, Index.html, appsscript.json.
 *   2. Run setup() once from the editor and authorise.
 *      (If you ran an earlier version, delete the old "Stories" tab first. The columns have changed.)
 *   3. Fill the verticals list in the "Config" sheet (column A).
 *   4. Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone within Teach For India".
 *   5. AIWC reviews rows in the "Stories" sheet and changes the Status column (Approved / Featured / Needs changes).
 *      Restrict edit access to the Sheet to AIWC members only.
 */

const CFG = {
  ALLOWED_DOMAIN: 'teachforindia.org',   // <- confirm this is your Workspace domain. Set '' to skip the check.
  STORIES: 'Stories',
  CONFIG: 'Config',
  DEFAULT_MIN_APPROVED: 10,
  DEFAULT_MIN_VERTICALS: 5,
  SHOW_CONTACT_EMAIL: true               // shows the submitter's work email on the story, as "contact"
};

const OPTIONS = {
  types: ['Self-led', 'Built by the Technology team'],
  tools: ['Claude', 'Gemini', 'ChatGPT', 'Salesforce AI', 'Other'],
  unlocks: ['Time / Effort savings', 'Cost savings', 'Made something new possible',
            'Unlocked an expertise for you / team', 'Others'],
  confidence: ['Measured', 'Estimated', 'Gut feel'],
  effort: ['An afternoon', 'A week', 'Needed support from the Technology team']
};

const UNLOCK = {
  TIME: OPTIONS.unlocks[0], COST: OPTIONS.unlocks[1], NEW: OPTIONS.unlocks[2],
  EXPERT: OPTIONS.unlocks[3], OTHER: OPTIONS.unlocks[4]
};

const LIMITS = {
  storyName: 80, summary: 140, story: 1000,
  unlockNew: 300, unlockExpertise: 300, unlockOther: 300,
  costNote: 200, advice: 300, didntWork: 400, toolOther: 100
};

const STATUS = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted', CHANGES: 'Needs changes',
  APPROVED: 'Approved', FEATURED: 'Featured'
};

// Column order of the "Stories" sheet. The last four (status, notes, annualHours, flag) are admin / computed.
const COLS = ['id', 'created', 'updated', 'email', 'name', 'vertical', 'storyName', 'type', 'tools', 'toolOther',
  'summary', 'story', 'unlocks', 'unlockNew', 'unlockExpertise', 'unlockOther',
  'minsBefore', 'minsAfter', 'cycles', 'costINR', 'costNote', 'confidence', 'didntWork',
  'effort', 'advice', 'safety', 'status', 'notes', 'annualHours', 'flag'];
const HEADERS = ['Story ID', 'Created', 'Updated', 'Submitter email', 'Submitter name', 'Vertical', 'Story name',
  'Type', 'Tools used', 'Other tool', 'One-line summary', 'The story (AS-IS to TO-BE)', 'What AI unlocked',
  'Detail: made something new possible', 'Detail: unlocked an expertise', 'Detail: others',
  'Minutes per cycle - before', 'Minutes per cycle - after', 'Cycles per month', 'Cost impact (INR)', 'Cost note',
  'Confidence in numbers', 'What did not work', 'Effort to get started', 'Advice for other verticals',
  'Data-safety confirmed', 'Status', 'AIWC notes', 'Annual hours saved (auto)', 'Auto flag'];
const COL = {};
COLS.forEach(function (k, i) { COL[k] = i + 1; });

/* ------------------------------------------------------------------ */
/* Web app entry                                                       */
/* ------------------------------------------------------------------ */

function doGet() {
  try {
    user_();
  } catch (err) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:24px">' + esc_(err.message) + '</p>');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('AI Stories | Teach For India')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    // Lets the GitHub Pages wrapper show this app inside an iframe. Sign-in is still enforced by the deployment.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ------------------------------------------------------------------ */
/* Functions called from the browser                                   */
/* ------------------------------------------------------------------ */

function getBootstrap() {
  const email = user_();
  const cfg = readConfig_();
  return {
    user: { email: email, name: nameFromEmail_(email) },
    verticals: cfg.verticals,
    options: OPTIONS,
    limits: LIMITS,
    myStories: myStories_(email)
  };
}

function getMyStories() {
  return myStories_(user_());
}

function getMyStory(id) {
  const email = user_();
  const row = allRows_().filter(function (r) { return r.id === id && r.email === email; })[0];
  if (!row) throw new Error('Story not found.');
  return {
    id: row.id, status: row.status, notes: row.status === STATUS.CHANGES ? String(row.notes || '') : '',
    vertical: row.vertical, storyName: row.storyName, type: row.type,
    tools: splitList_(row.tools), toolOther: row.toolOther,
    summary: row.summary, story: row.story, unlocks: splitList_(row.unlocks),
    unlockNew: row.unlockNew, unlockExpertise: row.unlockExpertise, unlockOther: row.unlockOther,
    minsBefore: row.minsBefore, minsAfter: row.minsAfter, cycles: row.cycles,
    costINR: row.costINR, costNote: row.costNote, confidence: row.confidence,
    didntWork: row.didntWork, effort: row.effort, advice: row.advice, safety: row.safety === true
  };
}

/**
 * Saves a story. submit=false saves as a draft, submit=true sends it for AIWC review.
 */
function saveStory(payload, submit) {
  const email = user_();
  const cfg = readConfig_();
  const d = clean_(payload || {});
  const errors = submit ? validateSubmit_(d, cfg) : validateDraft_(d, cfg);
  if (errors.length) return { ok: false, errors: errors };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(CFG.STORIES);
    const now = new Date();
    let row = 0, existing = null;

    if (d.id) {
      existing = allRows_().filter(function (r) { return r.id === d.id; })[0];
      if (!existing || existing.email !== email) return { ok: false, errors: ['Story not found.'] };
      row = existing._row;
      if (!submit && existing.status !== STATUS.DRAFT) {
        return { ok: false, errors: ['Only drafts can be saved as drafts. Use "Save and send for review".'] };
      }
    }

    const status = submit ? STATUS.SUBMITTED : STATUS.DRAFT;
    const v = {
      updated: now, email: email, name: nameFromEmail_(email), vertical: d.vertical, storyName: d.storyName,
      type: d.type, tools: d.tools.join(', '), toolOther: d.toolOther, summary: d.summary, story: d.story,
      unlocks: d.unlocks.join(', '), unlockNew: d.unlockNew, unlockExpertise: d.unlockExpertise,
      unlockOther: d.unlockOther, minsBefore: d.minsBefore, minsAfter: d.minsAfter, cycles: d.cycles,
      costINR: d.costINR, costNote: d.costNote, confidence: d.confidence, didntWork: d.didntWork,
      effort: d.effort, advice: d.advice, safety: d.safety
    };
    const keys = COLS.slice(COL.updated - 1, COL.safety);          // updated ... safety
    const values = keys.map(function (k) { return safeCell_(v[k]); });

    let id = d.id;
    if (!row) {
      id = Utilities.getUuid();
      row = sh.getLastRow() + 1;
      sh.getRange(row, COL.id, 1, 2).setValues([[id, now]]);
    }
    sh.getRange(row, COL.updated, 1, values.length).setValues([values]);
    sh.getRange(row, COL.status).setValue(status);

    const L = function (k) { return colLetter_(COL[k]) + row; };
    sh.getRange(row, COL.annualHours).setFormula(
      '=IF(AND(ISNUMBER(' + L('minsBefore') + '),ISNUMBER(' + L('minsAfter') + '),ISNUMBER(' + L('cycles') + ')),' +
      'ROUND(MAX(0,' + L('minsBefore') + '-' + L('minsAfter') + ')*' + L('cycles') + '*12/60,1),"")');
    sh.getRange(row, COL.flag).setFormula(
      '=IF(' + L('annualHours') + '="","",IF(' + L('annualHours') + '>1500,"Check numbers: over 1,500 hrs/yr",""))');

    let message = submit ? 'Thank you! Your story has been sent to the AI Working Committee for review.' : 'Draft saved.';
    if (submit && existing && (existing.status === STATUS.APPROVED || existing.status === STATUS.FEATURED)) {
      message = 'Your changes are saved. Because this story was already live, it will be hidden until the AI Working Committee reviews it again.';
    }
    return { ok: true, id: id, status: status, message: message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Server-enforced lock: returns no stories until the threshold is met.
 */
function getInspirations() {
  user_();
  const cfg = readConfig_();
  const live = allRows_().filter(function (r) {
    return r.status === STATUS.APPROVED || r.status === STATUS.FEATURED;
  });
  const verts = {};
  live.forEach(function (r) { verts[r.vertical] = true; });
  const vertCount = Object.keys(verts).length;

  if (live.length < cfg.minApproved || vertCount < cfg.minVerticals) {
    return { locked: true, approved: live.length, verticals: vertCount,
             minApproved: cfg.minApproved, minVerticals: cfg.minVerticals };
  }

  live.sort(function (a, b) {
    const fa = a.status === STATUS.FEATURED ? 1 : 0, fb = b.status === STATUS.FEATURED ? 1 : 0;
    if (fa !== fb) return fb - fa;
    return new Date(b.updated).getTime() - new Date(a.updated).getTime();
  });

  return {
    locked: false,
    verticals: Object.keys(verts).sort(),
    stories: live.map(publicStory_)
  };
}

/* ------------------------------------------------------------------ */
/* One-time setup                                                      */
/* ------------------------------------------------------------------ */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ROWS = 998;

  const sh = ss.getSheetByName(CFG.STORIES) || ss.insertSheet(CFG.STORIES);
  sh.getRange(2, 1, ROWS, HEADERS.length).clearDataValidations();
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontFamily('Calibri').setFontSize(10).setFontWeight('bold')
    .setBackground('#E7F8FC').setVerticalAlignment('middle').setWrap(true);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(7);
  sh.getRange(2, 1, ROWS, HEADERS.length).setFontFamily('Calibri').setFontSize(10).setVerticalAlignment('middle');
  const statusRange = sh.getRange(2, COL.status, ROWS, 1);
  statusRange.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList([STATUS.DRAFT, STATUS.SUBMITTED, STATUS.CHANGES, STATUS.APPROVED, STATUS.FEATURED], true)
      .setAllowInvalid(false).build());
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(STATUS.APPROVED).setBackground('#F1F6D0').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(STATUS.FEATURED).setBackground('#FFF1B8').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(STATUS.CHANGES).setBackground('#FFE2D0').setRanges([statusRange]).build()
  ]);
  sh.setColumnWidths(1, 5, 110);
  sh.setColumnWidth(COL.storyName, 200);
  sh.setColumnWidths(COL.summary, 6, 280);
  sh.getRange(2, 1, ROWS, 3).setNumberFormat('dd-mmm-yyyy hh:mm');
  sh.getRange(2, COL.email, ROWS, 1).setNumberFormat('@');

  let cf = ss.getSheetByName(CFG.CONFIG);
  if (!cf) {
    cf = ss.insertSheet(CFG.CONFIG);
    cf.getRange('A1:D1').setValues([['Verticals (one per row)', '', 'Setting', 'Value']]);
    cf.getRange('A2:A3').setValues([['Technology'], ['Recruitment']]);   // replace with your full list of verticals
    cf.getRange('C2:D3').setValues([['Minimum approved stories to unlock "Get inspired"', CFG.DEFAULT_MIN_APPROVED],
                                    ['Minimum number of different verticals among them', CFG.DEFAULT_MIN_VERTICALS]]);
    cf.getRange('A1:D1').setFontWeight('bold').setBackground('#E7F8FC');
    cf.setColumnWidth(1, 240); cf.setColumnWidth(3, 380);
  }
  SpreadsheetApp.getUi().alert('Setup complete. Add your verticals in the Config sheet (column A), then deploy as a web app.');
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function user_() {
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) throw new Error('We could not identify you. Please sign in with your Teach For India account.');
  if (CFG.ALLOWED_DOMAIN && !email.endsWith('@' + CFG.ALLOWED_DOMAIN)) {
    throw new Error('This tool is only available to Teach For India accounts.');
  }
  return email;
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" not found. Run setup() first.');
  return sh;
}

function readConfig_() {
  const sh = sheet_(CFG.CONFIG);
  const n = Math.max(sh.getLastRow() - 1, 1);
  const verticals = sh.getRange(2, 1, n, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); }).filter(Boolean);
  const num = function (cell, dflt) {
    const v = sh.getRange(cell).getValue();
    return (v === '' || !isFinite(Number(v))) ? dflt : Number(v);
  };
  return {
    verticals: verticals,
    minApproved: num('D2', CFG.DEFAULT_MIN_APPROVED),
    minVerticals: num('D3', CFG.DEFAULT_MIN_VERTICALS)
  };
}

function allRows_() {
  const sh = sheet_(CFG.STORIES);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, COLS.length).getValues().map(function (r, i) {
    const o = { _row: i + 2 };
    COLS.forEach(function (k, j) { o[k] = r[j]; });
    return o;
  }).filter(function (o) { return o.id; });
}

function myStories_(email) {
  return allRows_().filter(function (r) { return r.email === email; })
    .sort(function (a, b) { return new Date(b.updated).getTime() - new Date(a.updated).getTime(); })
    .map(function (r) {
      return {
        id: r.id, storyName: r.storyName || '(Untitled draft)', vertical: r.vertical, status: r.status,
        updated: iso_(r.updated), notes: r.status === STATUS.CHANGES ? String(r.notes || '') : ''
      };
    });
}

function publicStory_(r) {
  const unlocks = splitList_(r.unlocks);
  const has = function (k) { return unlocks.indexOf(UNLOCK[k]) > -1; };

  let time = null;
  if (has('TIME') && isNum_(r.minsBefore) && isNum_(r.minsAfter) && isNum_(r.cycles)) {
    const b = Number(r.minsBefore), a = Number(r.minsAfter), c = Number(r.cycles);
    time = { before: b, after: a, cycles: c, hours: Math.round(Math.max(0, b - a) * c * 12 / 60 * 10) / 10 };
  }
  const cost = (has('COST') && isNum_(r.costINR)) ? { inr: Number(r.costINR), note: String(r.costNote || '') } : null;

  const detail = {};
  detail[UNLOCK.NEW] = r.unlockNew;
  detail[UNLOCK.EXPERT] = r.unlockExpertise;
  detail[UNLOCK.OTHER] = r.unlockOther;

  const tools = splitList_(r.tools).map(function (t) {
    return (t === 'Other' && r.toolOther) ? 'Other: ' + r.toolOther : t;
  });
  return {
    id: r.id, featured: r.status === STATUS.FEATURED, vertical: r.vertical, storyName: r.storyName, type: r.type,
    tools: tools, summary: r.summary, story: r.story,
    unlockItems: unlocks.map(function (u) { return { label: u, detail: String(detail[u] || '') }; }),
    time: time, cost: cost, confidence: (time || cost) ? r.confidence : '',
    effort: r.effort, advice: r.advice, didntWork: r.didntWork,
    contactName: r.name, contactEmail: CFG.SHOW_CONTACT_EMAIL ? r.email : ''
  };
}

function clean_(p) {
  const s = function (v, max) { return String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max); };
  const n = function (v) {
    if (v === '' || v == null) return '';
    const x = Number(v);
    return isFinite(x) ? x : NaN;
  };
  const pick = function (arr, allowed) {
    return (Array.isArray(arr) ? arr : []).filter(function (t) { return allowed.indexOf(t) > -1; });
  };
  const tools = pick(p.tools, OPTIONS.tools);
  const unlocks = pick(p.unlocks, OPTIONS.unlocks);
  const has = function (k) { return unlocks.indexOf(UNLOCK[k]) > -1; };

  // Anything belonging to an option that is not ticked is dropped, so stale hidden answers never reach the Sheet.
  return {
    id: s(p.id, 60), vertical: s(p.vertical, 100), storyName: s(p.storyName, LIMITS.storyName),
    type: s(p.type, 60), tools: tools, toolOther: tools.indexOf('Other') > -1 ? s(p.toolOther, LIMITS.toolOther) : '',
    summary: s(p.summary, LIMITS.summary), story: s(p.story, LIMITS.story), unlocks: unlocks,
    unlockNew: has('NEW') ? s(p.unlockNew, LIMITS.unlockNew) : '',
    unlockExpertise: has('EXPERT') ? s(p.unlockExpertise, LIMITS.unlockExpertise) : '',
    unlockOther: has('OTHER') ? s(p.unlockOther, LIMITS.unlockOther) : '',
    minsBefore: has('TIME') ? n(p.minsBefore) : '', minsAfter: has('TIME') ? n(p.minsAfter) : '',
    cycles: has('TIME') ? n(p.cycles) : '',
    costINR: has('COST') ? n(p.costINR) : '', costNote: has('COST') ? s(p.costNote, LIMITS.costNote) : '',
    confidence: (has('TIME') || has('COST')) ? s(p.confidence, 30) : '',
    didntWork: s(p.didntWork, LIMITS.didntWork), effort: s(p.effort, 60), advice: s(p.advice, LIMITS.advice),
    safety: p.safety === true
  };
}

function validateDraft_(d, cfg) {
  const e = [];
  if (cfg.verticals.indexOf(d.vertical) < 0) e.push('Please choose your vertical.');
  if (!d.storyName) e.push('Please give your story a name.');
  ['minsBefore', 'minsAfter', 'cycles', 'costINR'].forEach(function (k) {
    if (d[k] !== '' && (isNaN(d[k]) || d[k] < 0)) e.push('Numbers must be zero or more.');
  });
  return e.filter(function (x, i, a) { return a.indexOf(x) === i; });
}

function validateSubmit_(d, cfg) {
  const e = validateDraft_(d, cfg);
  const need = function (ok, msg) { if (!ok) e.push(msg); };
  const has = function (k) { return d.unlocks.indexOf(UNLOCK[k]) > -1; };

  need(OPTIONS.types.indexOf(d.type) > -1, 'Please choose whether this was self-led or built by the Technology team.');
  need(d.tools.length > 0, 'Please select at least one tool or approach.');
  need(d.tools.indexOf('Other') < 0 || d.toolOther, 'You selected "Other" under tools. Please say which tool.');
  need(d.summary, 'Please add a one-line summary.');
  need(d.story, 'Please tell us more about how you have leveraged AI in this project.');

  need(d.unlocks.length > 0, 'Please select at least one thing AI unlocked for you.');
  need(!has('NEW') || d.unlockNew, 'Please add details on what new thing became possible.');
  need(!has('EXPERT') || d.unlockExpertise, 'Please add details on the expertise that was unlocked.');
  need(!has('OTHER') || d.unlockOther, 'Please add details for "Others".');

  if (has('TIME')) {
    need(d.minsBefore !== '' && d.minsAfter !== '' && d.cycles !== '',
         'Time / effort savings: please fill in minutes before, minutes after, and cycles per month.');
    need(d.minsBefore === '' || d.minsBefore <= 100000, 'Minutes before looks too high. Please check it.');
    need(d.cycles === '' || d.cycles <= 10000, 'Cycles per month looks too high. Please check it.');
  }
  if (has('COST')) {
    need(d.costINR !== '' && d.costINR > 0, 'Cost savings: please enter the amount saved or avoided (in ₹).');
    need(d.costNote, 'Cost savings: please add a short note on how you calculated it.');
  }
  if (has('TIME') || has('COST')) {
    need(OPTIONS.confidence.indexOf(d.confidence) > -1, 'Please say how confident you are in the numbers.');
  }

  need(d.didntWork, 'Please share what did not work, or what you would do differently.');
  need(OPTIONS.effort.indexOf(d.effort) > -1, 'Please choose how much effort it took to get started.');
  need(d.advice, 'Please add one piece of advice for another vertical.');
  need(d.safety, 'Please confirm the data-safety checkbox.');
  return e.filter(function (x, i, a) { return a.indexOf(x) === i; });
}

// Stops text starting with = + - @ from being treated as a formula in the Sheet.
function safeCell_(v) {
  return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v;
}

function splitList_(v) { return String(v || '').split(', ').filter(Boolean); }

function isNum_(v) { return v !== '' && v != null && isFinite(Number(v)); }

function colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function nameFromEmail_(email) {
  return String(email).split('@')[0].split(/[._-]+/).filter(Boolean)
    .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
}

function iso_(d) { return d instanceof Date ? d.toISOString() : ''; }

function esc_(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
