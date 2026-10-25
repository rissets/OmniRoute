# Local patches

## f0986a66bcde82a2863a92b58d2a072be32951d2

BP Batam branding for this deployment, requested by its operator. The vendored component APIs and compatibility identifiers remain unchanged.

- `src/keak-brand.tsx`: render the supplied institutional logo and BP Batam navigation instead of the upstream product lockups.
- `src/brand-loader.tsx`: use the official BP Batam emblem while preserving progress, animation and accessibility behavior.

These deployment-specific assets are maintained in this fork; they do not change the upstream snapshot provenance in `UPSTREAM.md`. Font and color overrides live in application CSS.
