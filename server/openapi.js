const string = { type: "string" };
const number = { type: "number" };
const integer = { type: "integer" };
const bool = { type: "boolean" };
const object = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const array = (items) => ({ type: "array", items });
const nullableString = { type: ["string", "null"] };
const requestId = {
  ...string,
  minLength: 1,
  maxLength: 200,
  description:
    "Unique ID per logical paid request. Reuse after transport uncertainty; never silently create a fresh charge.",
};