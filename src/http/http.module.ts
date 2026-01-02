import { Module, Global } from '@nestjs/common';
import { HttpService } from './http.service';
import { ConfigModule } from '@nestjs/config';
import appConfig from '../config/app.config';

@Global()
@Module({
    imports: [ConfigModule.forFeature(appConfig)],
    providers: [HttpService],
    exports: [HttpService],
})
export class HttpModule { }
