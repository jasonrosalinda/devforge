export interface ApiResult {
  success: boolean;
  status: number;
  message?: string;
};

export class MetricsResult {
  before: number;
  after: number;

  constructor(before: number, after: number) {
    this.before = before;
    this.after = after;
  }

  get improvement(): number {
    return ((this.before - this.after) / this.before) * 100;
  }
}