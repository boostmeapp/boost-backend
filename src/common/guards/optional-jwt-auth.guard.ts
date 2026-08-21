import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';


@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // No token / bad token / expired token — proceed as a guest.
    }
    return true;
  }

  handleRequest(_err: any, user: any) {
    return user || undefined;
  }
}
