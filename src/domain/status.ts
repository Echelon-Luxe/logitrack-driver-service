export const DRIVER_STATUSES = ['OFFLINE', 'AVAILABLE', 'ON_JOB'] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export interface DriverState {
  availability: 'ONLINE' | 'OFFLINE';
  currentShipmentId: string | null;
}

// Derived, never stored. The two inputs have separate writers - the driver
// owns availability, the event stream owns currentShipmentId - so neither can
// clobber the other and there is no status field to race over.
export function effectiveStatus(d: DriverState): DriverStatus {
  if (d.availability === 'OFFLINE') return 'OFFLINE';
  return d.currentShipmentId ? 'ON_JOB' : 'AVAILABLE';
}

// A driver going offline mid-job stays ON_JOB for dispatch purposes: the
// shipment is still assigned to them, and showing them as free would let
// dispatch double-book.
export const isAssignable = (d: DriverState): boolean =>
  effectiveStatus(d) === 'AVAILABLE';
