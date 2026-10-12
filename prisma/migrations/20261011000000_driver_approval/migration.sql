ALTER TABLE "Driver"
  ADD COLUMN "plateNumber" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvedBy" TEXT;
