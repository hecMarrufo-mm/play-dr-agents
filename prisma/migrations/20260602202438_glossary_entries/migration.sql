-- CreateTable
CREATE TABLE "glossary_entries" (
    "id" TEXT NOT NULL,
    "sourceTerm" TEXT NOT NULL,
    "sourceTermLower" TEXT NOT NULL,
    "targetLang" TEXT NOT NULL,
    "preferredTranslation" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "glossary_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "glossary_entries_targetLang_idx" ON "glossary_entries"("targetLang");

-- CreateIndex
CREATE UNIQUE INDEX "glossary_entries_sourceTermLower_targetLang_key" ON "glossary_entries"("sourceTermLower", "targetLang");

-- AddForeignKey
ALTER TABLE "glossary_entries" ADD CONSTRAINT "glossary_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
