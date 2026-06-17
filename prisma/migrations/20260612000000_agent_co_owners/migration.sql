-- CreateTable
CREATE TABLE "agent_owners" (
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_owners_pkey" PRIMARY KEY ("agentId","userId")
);

-- CreateIndex
CREATE INDEX "agent_owners_userId_idx" ON "agent_owners"("userId");

-- AddForeignKey
ALTER TABLE "agent_owners" ADD CONSTRAINT "agent_owners_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_owners" ADD CONSTRAINT "agent_owners_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

