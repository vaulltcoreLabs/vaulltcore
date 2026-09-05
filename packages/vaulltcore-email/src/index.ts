export * from "./contracts"
export { escapeHtml, assertSameOriginLink } from "./escape"
export { renderTemplate, type TemplateEmail, type LinkTemplateDetails, type OtpTemplateDetails } from "./templates"
export {
  ResendEmailProvider,
  DevelopmentEmailProvider,
  nodeHttpTransport,
  type ResendEmailProviderOptions,
  type DevelopmentEmailProviderOptions,
  type HttpTransport,
} from "./providers"
export { DefaultEmailService } from "./service"
export type { EmailService } from "./contracts"