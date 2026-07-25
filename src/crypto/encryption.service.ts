import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Encryption } from './encryption';

/**
 * Wrapper Nest de Encryption. Inyecta ConfigService solo para garantizar
 * que ConfigModule ya cargó .env a process.env antes de parsear las claves.
 */
@Injectable()
export class EncryptionService extends Encryption {
  constructor(_config: ConfigService) {
    super(Encryption.parseEnv(process.env));
  }
}
