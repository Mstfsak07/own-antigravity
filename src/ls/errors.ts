export class LsError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode = 502) {
    super(message);
  }
}

export class LsCoreMissing extends LsError {
  constructor(message = "ls_core is missing") {
    super(message, "LsCoreMissing", 503);
  }
}

export class LsCoreStartFailed extends LsError {
  constructor(message = "ls_core failed to start") {
    super(message, "LsCoreStartFailed", 502);
  }
}

export class LsCoreCrashed extends LsError {
  constructor(message = "ls_core crashed") {
    super(message, "LsCoreCrashed", 502);
  }
}

export class LsTransportUnsupported extends LsError {
  constructor(message = "LS transport is not supported") {
    super(message, "LsTransportUnsupported", 501);
  }
}

export class LsRequestTimeout extends LsError {
  constructor(message = "LS request timed out") {
    super(message, "LsRequestTimeout", 504);
  }
}

export class LsProtocolError extends LsError {
  constructor(message = "LS protocol error") {
    super(message, "LsProtocolError", 502);
  }
}

export class LsAuthError extends LsError {
  constructor(message = "LS auth error") {
    super(message, "LsAuthError", 401);
  }
}
