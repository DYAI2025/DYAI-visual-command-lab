export interface AuthPrincipal {
  userId: string;
}

export interface AuthPort {
  requirePrincipal(request: Request): Promise<AuthPrincipal>;
}
