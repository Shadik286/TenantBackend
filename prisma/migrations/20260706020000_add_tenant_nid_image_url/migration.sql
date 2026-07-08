-- Stores an image of the tenant's national-ID card so the details sheet
-- and tenant form can render it alongside the profile photo. Nullable —
-- legacy rows are left empty and the UI hides the field when blank.
-- We accept either a remote URL or a base64/data URL; the column is
-- TEXT (no length cap) so callers can store either without a separate
-- upload pipeline.

ALTER TABLE "Tenant"
  ADD COLUMN "nid_image_url" TEXT;
