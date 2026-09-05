import type { AuthEmail, EmailProvider, EmailService } from "./contracts"

/** Neutral facade. The application depends on this; production wires Resend. */
export class DefaultEmailService implements EmailService {
  readonly providerId: string
  private readonly provider: EmailProvider
  constructor(provider: EmailProvider) {
    this.provider = provider
    this.providerId = provider.id
  }

  async send(email: Readonly<AuthEmail>): Promise<{ messageId: string }> {
    return this.provider.send(email)
  }
}