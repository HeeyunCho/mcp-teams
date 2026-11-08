/**
 * An unsigned JWT with these claims, as Teams' tokens look to the worker (it only decodes the
 * payload). `iat` (when the token was issued, seconds since 1970) is what tells an old token
 * from a fresh one (#77): give it where the age matters, leave it out for a token without one.
 */
export const fakeJwt = (claims: object) => `${[{ alg: "none", typ: "JWT" }, claims].map((o) => Buffer.from(JSON.stringify(o)).toString("base64url")).join(".")}.`;
