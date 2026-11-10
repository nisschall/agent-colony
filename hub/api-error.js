// An error with the HTTP status the hub should answer with.
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { ApiError };
