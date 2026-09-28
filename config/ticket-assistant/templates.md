<!-- Copia literal de ai-toolkit: plugins/azure-devops/skills/create-work-item/references/templates.md. Para actualizarla, vuelve a copiar ese fichero debajo de esta línea. -->

# Work item templates

Defaults for the four kinds of item. **The team's existing items outrank these**: if the
similar items you read use other headings, another title shape or another depth, follow
them.

Headings render bold in Azure DevOps; write them as `**Heading:**`.

## Titles

Section paths are separated by `/`; the description follows a `-`, `–` or `.`. Use the
real section names of the product, never invented ones. When the data is at fault, name
the exact fields or endpoint in the title.

```
Frontend story   Administration / Users - Redesign of the users panel
Frontend story   Orders – Order detail panel with summary, lines and shipments
Backend story    BFF - Suppliers. Suppliers CRUD endpoints
Frontend bug     Orders / History – Do not render empty status columns when no data is returned
Backend bug      BFF - Orders. Delivery address not shown due to empty coordinates from the orders endpoint
Backend bug      Administration / Products – Update endpoint does not persist weight and unitPrice
```

The `BFF -` prefix above is one team's marker for backend items on a shared board. Use
whatever marker the existing items use, or none if they use none.

## User Story - frontend

**Description**

```
**Functionality:**

<What must be implemented and the current state. Say explicitly when this is new behaviour
with no reference screen. Name the real sections, endpoints and permissions.>

<Layout of the screen when it is not trivial: left panel, central panel, right panel.>

**User Functionality:**

<What the user sees and can do, in flow order. Who can access it and under which
permission. What updates dynamically. The limits, and the feedback the user gets on them.>
```

**Acceptance Criteria**

```
**This task includes:**

- <Actionable item>
  - <Sub-item - two and three levels are normal>
- Translations for <label> in every supported language (main label: "<label>")
- <UI elements, validation, feedback, table columns, filters>

**This task does NOT include:**

- Backend endpoint implementation or changes.
- <Out-of-scope UI>
- <Future enhancements>
```

A frontend story almost always **excludes** backend changes, export to Excel or PDF,
persisting state between sessions and permission-management screens. It almost always
**includes** the translations, permission-based access (blocking direct URL navigation
too) and the section's standard layout and validation. State them: the excludes are what
stop scope creep in refinement.

## User Story - backend

**Description**

```
**Functionality:**

A new set of endpoints must be created and exposed to support the frontend section
**<Section / Subsection>**.

<What they must cover, and the responsibility boundary: "This task focuses exclusively on
CRUD for X".>

The exposed endpoints must allow:
- Retrieving all <resources> for <scope>.
- Retrieving one <resource> in full detail.
- Creating / updating / deleting a <resource>.

All returned data must be directly consumable by the frontend, with no coded or encoded
fields. <Format requirements with a concrete example.>

<Existing API used as a reference, if any, marked as functional reference only.>

**User Functionality:**

<What the user can do in the frontend once these endpoints exist.>
```

**Acceptance Criteria**

```
**This task includes:**

- Design and implementation of REST endpoints to manage <resource>:
  - Create / read list / read detail / update / delete
- Responses structured for direct frontend consumption:
  - No coded, encrypted or compacted fields.
  - <Format requirement with an example>
- Correct HTTP methods, status codes and error handling for every operation.
- API documentation (Swagger / OpenAPI) for every new endpoint.

**This task does NOT include:**

- Frontend UI implementation or changes.
- Changes to existing endpoints of <other system>.
- Any mapping or decoding to be done on the frontend.
- <Adjacent features deliberately left out>
```

## Bug - frontend

**Repro Steps** (everything goes here; Description stays empty)

```
**Error description:**

<What happens, naming the account used to reproduce it: "When logging in with user <x>
and opening <Section / Subsection>...">

<Why it is wrong: the rule or expectation violated and its practical consequence.>

**Steps to reproduce the error:**

1. Log in with the user <account>.
2. Navigate to <exact path>.
3. <Observation>
4. <Step that makes the defect evident: sorting, filtering, inspecting>

**Expected behavior:**

- <The correct behaviour, as a rule>
- <Edge case that must also hold>
- <What must not happen>

**This task includes:**

- <Fix scope, when the expected behaviour does not make it obvious>
- Validate the behaviour with <the variations to check>
```

## Bug - backend

**Repro Steps**

```
**Error description:**

<What happens, from the user's point of view first.>

Inspection of the <endpoint> response shows that <the data defect: the fields and their
wrong values>.

This is incorrect because <the rule>. The backend currently <what it does wrong and when>.

As a result:
- <Observable consequence>
- <Observable consequence>

**Steps to reproduce the error:**

1. Log in with the user <account>.
2. <Precondition: permissions, company, device type>
3. Navigate to <path>.
4. <Observation>
5. Inspect the network request to <endpoint>.
6. Verify that <field> is returned as <wrong value>.

**Expected behavior:**

- <The contract the endpoint must honour>
- <Isolation rules: "vehicle permissions must not affect driver data">
- <What must never happen, especially data crossing companies, accounts or devices>
```

For a data isolation bug, say so in the description: *"This is a data isolation and
integrity issue: users can download documents that do not belong to their company."*
