-- AlterTable
ALTER TABLE "public"."Attachment" ADD COLUMN     "document_type" TEXT,
ADD COLUMN     "tenant_id" TEXT;

-- AlterTable
ALTER TABLE "public"."Tenant" ADD COLUMN     "photo_url" TEXT;

-- CreateTable
CREATE TABLE "public"."TenantFamilyMember" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantFamilyMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantFamilyMember_tenant_id_idx" ON "public"."TenantFamilyMember"("tenant_id");

-- CreateIndex
CREATE INDEX "Attachment_tenant_id_document_type_idx" ON "public"."Attachment"("tenant_id", "document_type");

-- AddForeignKey
ALTER TABLE "public"."TenantFamilyMember" ADD CONSTRAINT "TenantFamilyMember_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
