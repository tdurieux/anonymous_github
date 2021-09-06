import { CustomError } from 'ts-custom-error'

/**
 * Custom error message
 */
export default class AnonymousError extends CustomError {
  
  value: any;

  constructor(message: string, value?: any) {
    super(message);
    this.value = value;
  }

  toString(): string {
    return this.message;
  }
}
