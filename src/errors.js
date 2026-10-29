// An error meant for the user. The message is a translation key (src/i18n.js);
// the server translates it into the user's language.
export class UserError extends Error {
  constructor(key, vars = {}, status = 400) {
    super(key);
    this.key = key;
    this.vars = vars;
    this.status = status;
  }
}
