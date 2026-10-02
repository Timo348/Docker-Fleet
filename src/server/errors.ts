export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class AgentError extends ApiError {
  constructor(
    message: string,
    code = 'AGENT_UNAVAILABLE',
    public uncertain = false,
    status = 502,
  ) {
    super(status, code, message);
    this.name = 'AgentError';
  }
}
