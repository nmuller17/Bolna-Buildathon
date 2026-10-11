// Text hygiene (docs/features-plan.md F3 test 6 and section 3 "Text hygiene"). Run with `npm run test:unit`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addRedactions, foldConfusables, hygieneForEgress, hygieneForGuest, luhnValid, normalizeText } from "./hygiene.ts";

test("F3-6: a Luhn-valid card number is hidden in the guest caption, with or without spaces or dashes", () => {
  for (const said of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "5500 0000 0000 0004"]) {
    const r = hygieneForGuest(`My card is ${said} thanks`);
    assert.equal(r.text, "My card is [number hidden] thanks", said);
    assert.equal(r.redactions.card_number, 1);
  }
  // Not Luhn-valid: a guest caption keeps it (it may be a booking number the guest must read).
  assert.equal(hygieneForGuest("Booking 4111 1111 1111 1112").text, "Booking 4111 1111 1111 1112");
});

test("F3-6: full-width digits and ligatures are normalised (NFKC) before matching; zero-width characters removed", () => {
  const fullWidth = "Card ４１１１ １１１１ １１１１ １１１１ ok";
  assert.equal(hygieneForGuest(fullWidth).text, "Card [number hidden] ok");
  assert.equal(normalizeText("ﬁve ﬂoors"), "five floors");
  const zw = "4111​1111‌1111‍1111";
  assert.equal(hygieneForGuest(`n ${zw}`).text, "n [number hidden]");
  assert.equal(normalizeText("room­ 517⁠"), "room 517");
  assert.equal(normalizeText("a\u0000b c"), "a b c");
});

test("room numbers, times and short numbers stay readable in guest captions", () => {
  for (const s of ["You're in room 517.", "Breakfast is from 7 to 10.", "Checkout is at 11 a.m.", "Call 555 0100"]) {
    assert.equal(hygieneForGuest(s).text, s);
    assert.deepEqual(hygieneForGuest(s).redactions, {});
  }
});

test("egress: emails, long digit runs, password phrases and key shapes are hidden; counts by kind only", () => {
  const r = hygieneForEgress("Email me at guest.name+x@example.co.uk, the password is Tr0ub4dor and my number is 617 555 0100 22");
  assert.equal(r.text, "Email me at [email hidden], the password is [hidden] and my number is [number hidden]");
  assert.deepEqual(r.redactions, { email: 1, secret_phrase: 1, long_digits: 1 });
  assert.equal(hygieneForEgress("Your PIN 4471 works").text, "Your PIN [hidden] works");
  assert.equal(hygieneForEgress("wifi key: BlueSky42!").text, "wifi key: [hidden]");
  // An ordinary word after "password is" is not a value.
  assert.equal(hygieneForEgress("The Wi-Fi password is on your key card.").text, "The Wi-Fi password is on your key card.");
  const k = hygieneForEgress("key sk-abcdefghijklmnopqrstuv and ya29.AAAAAAAAAAAAAAAAAAAAAAAAAA end");
  assert.equal(k.text, "key [hidden] and [hidden] end");
  assert.equal(k.redactions.token_shape, 2);
});

test("egress: look-alike letters (Cyrillic, Greek) and full-width forms cannot disguise a secret", () => {
  // "раssword" with Cyrillic р and а; "ѕk-" with Cyrillic ѕ.
  assert.equal(hygieneForEgress("the раssword is hunter22").text, "the раssword is [hidden]");
  assert.equal(hygieneForEgress("ѕk-ABCDEFGHIJKLMNOPQRSTUVWX").text, "[hidden]");
  assert.equal(hygieneForEgress("ｐａｓｓｗｏｒｄ： ｓｅｃｒｅｔ９").text, "password: [hidden]");
  assert.equal(foldConfusables("раss").length, "раss".length, "folding keeps offsets");
});

test("luhn and redaction totals", () => {
  assert.equal(luhnValid("79927398713"), true);
  assert.equal(luhnValid("79927398710"), false);
  const total = {};
  addRedactions(total, { email: 1 });
  addRedactions(total, { email: 2, card_number: 1 });
  assert.deepEqual(total, { email: 3, card_number: 1 });
});
