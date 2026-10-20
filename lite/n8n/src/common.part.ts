// Shared by every RoofOps Lite workflow. lite/build.ts inlines this file (and the chosen config) into each workflow, so
// each generated workflow is one self-contained n8n SDK file. Nothing here is specific to one business.
const CONFIG = __LITE_CONFIG__;
// Airtable table URLs (base + URL-encoded table name), computed by lite/build.ts from the config.
const T = __LITE_TABLE_URLS__;
const CRED = { airtableTokenApi: { id: CONFIG.airtable.credential.id, name: CONFIG.airtable.credential.name } };
// Webhook protection (optional until go-live): n8n Header Auth with the configured credential.
const HOOK_AUTH = CONFIG.webhookAuth ? { authentication: 'headerAuth' } : {};
const HOOK_CRED = CONFIG.webhookAuth ? { credentials: { httpHeaderAuth: { id: CONFIG.webhookAuth.id, name: CONFIG.webhookAuth.name } } } : {};
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const OK_IF = (name, leftValue) => ifElse({ version: 2.3, config: { name, parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr(leftValue), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });
const code = (name, js) => node({ type: 'n8n-nodes-base.code', version: 2, config: { name, parameters: { mode: 'runOnceForAllItems', jsCode: libFor(js) + js } }, output: [{ ok: true }] });
const airtableList = (name, url, formula) => node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name, onError: 'continueRegularOutput',
  parameters: { method: 'GET', url, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', sendQuery: true,
    queryParameters: { parameters: [{ name: 'filterByFormula', value: expr(formula) }, { name: 'pageSize', value: '100' }] }, options: RAW },
  credentials: CRED }, output: [{ statusCode: 200, body: { records: [] } }] });
const airtableWrite = (name, method, url, body = '{{ JSON.stringify($json.request) }}') => node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name, onError: 'continueRegularOutput',
  parameters: { method, url, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr(body), options: RAW },
  credentials: CRED }, output: [{ statusCode: 200, body: { records: [{ id: 'rec' }] } }] });
const respond = (name) => node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.1, config: { name,
  parameters: { respondWith: 'json', responseBody: expr('{{ JSON.stringify($json.response.body) }}'), options: { responseCode: expr('{{ $json.response.status }}') } } }, output: [{}] });

/** Helpers available inside every Code node (plain JavaScript, run by n8n). */
const LIB = `
const CFG = ${JSON.stringify(CONFIG)};
const NOW = new Date();
const iso = (d) => new Date(d).toISOString();
const days = (n) => n * 24 * 60 * 60 * 1000;
const clean = (s) => String(s == null ? '' : s).trim();
const formulaText = (s) => clean(s).replace(/[\\\\'"{}]/g, '');
const normEmail = (s) => { const e = clean(s).toLowerCase(); return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(e) ? e : ''; };
const normPhone = (s) => { let d = clean(s).replace(/[^0-9+]/g, ''); if (d.startsWith('+61')) d = '0' + d.slice(3); d = d.replace(/[^0-9]/g, ''); return /^0[2-478][0-9]{8}$/.test(d) ? d : ''; };
const firstNameOf = (n) => clean(n).split(/\\s+/)[0] || 'there';
const render = (tpl, v) => String(tpl).replace(/\\{(\\w+)\\}/g, (m, k) => (v[k] == null ? m : String(v[k])));
const vars = (contact, job) => ({ firstName: contact['First Name'] || firstNameOf(contact.Name), businessName: CFG.business.name, businessPhone: CFG.business.phone,
  signoff: CFG.business.signoff, service: (job && job.Service) || ('your ' + CFG.business.trade + ' job'), reviewUrl: CFG.reviews.googleReviewUrl });
/** An Airtable answer, or an Error that fails the execution (n8n records it; nothing is marked done). */
const records = (r, step) => {
  if (!r || r.statusCode !== 200) { const b = (r && r.body) || {}; const e = b.error || (r && r.error) || {}; throw new Error(step + ': Airtable ' + (r && r.statusCode ? 'HTTP ' + r.statusCode : 'no response') + ' ' + clean(typeof e === 'string' ? e : (e.message || e.type))); }
  if (!r.body || !Array.isArray(r.body.records)) throw new Error(step + ': Airtable answered without a record list');
  return r.body.records;
};
/** Which channel may carry a message to this contact: the preferred one if it is consented and reachable, else the other. */
const channelFor = (c) => {
  if (c['Opted Out']) return { skip: 'opted out' };
  const can = { SMS: !!c['Consent SMS'] && !!normPhone(c.Phone), Email: !!c['Consent Email'] && !!normEmail(c.Email) };
  const order = c['Preferred Channel'] === 'Email' ? ['Email', 'SMS'] : ['SMS', 'Email'];
  const ch = order.find((x) => can[x]);
  if (!ch) return { skip: 'no consent or no reachable contact detail' };
  return { channel: ch, to: ch === 'SMS' ? normPhone(c.Phone) : normEmail(c.Email) };
};
/** The TEST message sink: records what would be sent. No provider is called; nothing reaches a real phone or inbox. */
const deliver = (ch, to, subject, body) => ({ status: 'Simulated Sent', provider: CFG.messaging.provider, channel: ch, to, subject: subject || null, body });
const logRef = (prefix) => prefix + '-' + iso(NOW).replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
`;

/** Each Code node gets only the helpers it uses (and theirs): the library above, split at each top-level const. */
const LIB_PARTS = (() => {
  const parts = []; let comment = [];
  for (const line of LIB.split('\n')) {
    if (!line.trim()) continue;
    const m = /^const (\w+) =/.exec(line);
    if (m) { parts.push({ name: m[1], lines: [...comment, line] }); comment = []; }
    else if (line.startsWith('/**')) comment.push(line);
    else parts[parts.length - 1].lines.push(line);
  }
  return parts.map((p) => ({ name: p.name, text: p.lines.join('\n') }));
})();
const uses = (text, name) => new RegExp('(^|[^\\w.$\'])' + name + '([^\\w]|$)').test(text);
const libFor = (js) => {
  const need = new Set();
  const add = (part) => { if (need.has(part.name)) return; need.add(part.name); LIB_PARTS.filter((q) => q !== part && uses(part.text, q.name)).forEach(add); };
  LIB_PARTS.filter((p) => uses(js, p.name)).forEach(add);
  return '\n' + LIB_PARTS.filter((p) => need.has(p.name)).map((p) => p.text).join('\n') + '\n';
};

