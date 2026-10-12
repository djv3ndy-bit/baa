/** A Google-only generic boundary error; no legacy checkout runtime import. */
export class CheckoutUnavailable extends Error {
  constructor(code) {super('Native checkout unavailable');this.code=code;}
}
