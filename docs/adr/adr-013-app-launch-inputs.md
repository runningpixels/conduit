# ADR 013: Launch inputs for pages and apps

## Status
Accepted — 2026-09-30. Extends [ADR 012](adr-012-page-bridge-storage.md).

## Decision
A page can declare a few typed **inputs** — a city, units, a currency pair —
that Conduit asks for in a form it draws itself, stores per app, and hands to
the page as `window.conduit.inputs`. Changing them updates the running page
without reloading it. The page never renders its own settings screen for
these, and model-written HTML is never the carrier of the values.

## How it works
1. **Declaring.** One block in the page:
   ```html
   <script type="application/conduit-inputs+json">
   [{ "id": "city", "label": "City", "type": "string", "default": "Paris", "required": true },
    { "id": "units", "label": "Units", "type": "enum", "options": ["metric", "imperial"], "default": "metric" }]
   </script>
   ```
   A script of that type never runs and needs no CSP change. Types:
   `string` (≤ 500 characters), `number` (finite), `boolean`, `enum` (one of
   1–50 `options`), `date` (`YYYY-MM-DD`). At most 20 inputs; ids are 1–40
   characters of letters, digits, `-` and `_`; labels 1–60 characters. There is
   deliberately no secret type (credentials are a Rust concern per host).
2. **Saving as an app** records the inputs in the manifest. Rust validates
   the declaration again, and rejects unknown fields and invalid defaults.
3. **Values** live in `app_inputs`, encrypted like other content, one row per
   app. A stored value is used only while its input is still declared and the
   value still fits it; otherwise the default applies.
4. **The form.** The app view has an **Inputs** button when the app declares
   any. On the first open, if a required input has no value and no default,
   the form opens before the page is useful. Saving validates in Rust, then
   posts the new values to the page.
5. **The page side.** When a page declares inputs, the bridge script (ADR 012)
   defines `window.conduit.inputs`, a frozen object of the current values,
   serialized into the Conduit-owned script at render time. A change arrives
   as a host message; the script swaps the object and dispatches
   `conduit:inputs-changed` on `window` with the new values as `detail`.
6. **Chat pages** get their declared defaults and no form: inputs are an app
   feature, and a page in a chat is edited by asking for a change.

## Consequences
- Updating an app from its source keeps stored values for inputs that are
  still declared; values for removed inputs are dropped.
- Deleting an app deletes its values. Exported apps (later) never carry them.
- The model is told how to declare inputs and to read them from
  `window.conduit.inputs`, falling back to its own defaults when absent.
