/**
 * [Lite] reply relay: a Twilio Function in front of the n8n reply webhook, for clients whose n8n plan has no
 * Variables (n8n Cloud Starter), so n8n cannot check X-Twilio-Signature itself.
 *
 * Set the Function's visibility to "Protected". Twilio then refuses every request to it whose X-Twilio-Signature is
 * missing or wrong, before this code runs. What reaches this code came from Twilio, unchanged. It forwards the
 * parameters to n8n with a secret header, which the reply webhook's n8n Header Auth credential requires
 * (config: messaging.twilio.inboundAuth "header-auth").
 *
 * Point the Twilio number's "A message comes in" webhook at this Function, and set config messaging.twilio
 * statusCallbacks: true and statusCallbackUrl: "<Function URL>?event=status", so delivery receipts come through it too.
 *
 * Environment variables (Functions > Service > Settings > Environment Variables):
 *   N8N_REPLY_URL      https://<n8n>/webhook/<replies.webhookPath>
 *   RELAY_HEADER_NAME  the Name of the n8n Header Auth credential, e.g. X-Lite-Relay-Key
 *   RELAY_SECRET       its Value: a long random string, kept only there and in n8n
 *
 * Twilio Functions are not available on trial accounts.
 */
exports.handler = async function (context, event, callback) {
  const isStatus = event.event === 'status';
  // Twilio's POST parameters arrive as top-level fields; `request` (headers, cookies) and our own `event` are not forwarded.
  const params = {};
  for (const [k, v] of Object.entries(event)) if (k !== 'request' && k !== 'event' && v != null && typeof v !== 'object') params[k] = String(v);
  let ok = false;
  try {
    const r = await fetch(context.N8N_REPLY_URL + (isStatus ? '?event=status' : ''), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', [context.RELAY_HEADER_NAME]: context.RELAY_SECRET },
      body: new URLSearchParams(params).toString(),
    });
    ok = r.ok;
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    // Twilio records the failure (Debugger, error 11200); it does not resend an incoming SMS by itself.
    const res = new Twilio.Response();
    res.setStatusCode(502);
    res.setBody('n8n did not accept the request');
    return callback(null, res);
  }
  // An empty TwiML answer: nothing is sent back to the person.
  return callback(null, isStatus ? '' : new Twilio.twiml.MessagingResponse());
};
