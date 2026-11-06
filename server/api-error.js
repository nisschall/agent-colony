// An error with an HTTP status, thrown by API handlers.

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { ApiError };
