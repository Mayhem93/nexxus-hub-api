import { NexxusException } from "@mayhem93/nexxus-core-lib";

enum HubApiExceptions {
  INVALID_PARAMETERS = "InvalidParametersException",
  NOT_FOUND = "NotFoundException",
  SERVER_ERROR = "ServerErrorException",
  APPLICATION_NOT_FOUND = "ApplicationNotFoundException",
  NO_AUTH_PRESENT = "NoAuthPresentException",
  USER_AUTH_FAILED = "UserAuthenticationFailedException"
};

export abstract class NexxusHubApiException extends NexxusException {
  public abstract readonly statusCode: number;

  constructor(name: HubApiExceptions, message: string) {
    super(name, message);
  }
}

export class InvalidParametersException extends NexxusHubApiException {
  public readonly statusCode = 400;

  constructor(message: string) {
    super(HubApiExceptions.INVALID_PARAMETERS, message);
  }
}

export class ServerErrorException extends NexxusHubApiException {
  public readonly statusCode = 500;

  constructor(message: string) {
    super(HubApiExceptions.SERVER_ERROR, message);
  }
}
export class NotFoundException extends NexxusHubApiException {
  public readonly statusCode = 404;

  constructor(message: string) {
    super(HubApiExceptions.NOT_FOUND, message);
  }
}

export class ApplicationNotFoundException extends NexxusHubApiException {
  public readonly statusCode = 404;

  constructor(message: string) {
    super(HubApiExceptions.APPLICATION_NOT_FOUND, message);
  }
}

export class UserAuthenticationFailedException extends NexxusHubApiException {
  public readonly statusCode = 401;

  constructor(message: string) {
    super(HubApiExceptions.USER_AUTH_FAILED, message);
  }
}

export class NoAuthPresentException extends NexxusHubApiException {
  public readonly statusCode = 401;

  constructor(message: string) {
    super(HubApiExceptions.NO_AUTH_PRESENT, message);
  }
}
