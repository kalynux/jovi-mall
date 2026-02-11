export class CalendarNotConnectedError extends Error {
  constructor(message = 'User has not connected a calendar account') {
    super(message);
    this.name = 'CalendarNotConnectedError';
    Object.setPrototypeOf(this, CalendarNotConnectedError.prototype);
  }
}

export class CalendarAuthExpiredError extends Error {
  constructor(message = 'Calendar authentication has expired or been revoked') {
    super(message);
    this.name = 'CalendarAuthExpiredError';
    Object.setPrototypeOf(this, CalendarAuthExpiredError.prototype);
  }
}

export class CalendarPermissionError extends Error {
  constructor(message = 'Insufficient permissions to access calendar') {
    super(message);
    this.name = 'CalendarPermissionError';
    Object.setPrototypeOf(this, CalendarPermissionError.prototype);
  }
}

export class CalendarProviderError extends Error {
  public readonly providerCode?: string;
  public readonly providerMessage?: string;

  constructor(message: string, providerCode?: string, providerMessage?: string) {
    super(message);
    this.name = 'CalendarProviderError';
    this.providerCode = providerCode;
    this.providerMessage = providerMessage;
    Object.setPrototypeOf(this, CalendarProviderError.prototype);
  }
}

export class CalendarConflictError extends Error {
  constructor(message = 'Calendar operation conflict detected') {
    super(message);
    this.name = 'CalendarConflictError';
    Object.setPrototypeOf(this, CalendarConflictError.prototype);
  }
}
