// Błąd do pokazania użytkownikowi. Treść jest kluczem tłumaczenia (src/i18n.js),
// a tłumaczenie robi serwer w języku, w którym pracuje użytkownik.
export class UserError extends Error {
  constructor(key, vars = {}, status = 400) {
    super(key);
    this.key = key;
    this.vars = vars;
    this.status = status;
  }
}
