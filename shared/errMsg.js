// errMsg — safe extraction of a human-readable message from a thrown value.
//
// catch bindings are `unknown` under strict TS, so `err.message` is a type
// error. This returns the message for real Errors, the string form otherwise,
// and a fallback when the thrown value carried no message at all. Never throws.

function errMsg(err) {
  if (err instanceof Error) return err.message || String(err);
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && typeof err.message === 'string') return err.message;
  return String(err);
}

module.exports = { errMsg };