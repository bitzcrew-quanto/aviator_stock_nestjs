import { Injectable, Logger, Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as http from 'http';
import * as https from 'https';
import appConfig from '../config/app.config';
import {
    HqBetRequest,
    HqBetResponse,
    HqCreditRequest,
    HqCreditResponse
} from './interfaces';

@Injectable()
export class HttpService {
    private readonly logger = new Logger(HttpService.name);
    private client: AxiosInstance;

    constructor(
        @Inject(appConfig.KEY)
        private readonly config: ConfigType<typeof appConfig>,
    ) { }

    async placeBet(request: HqBetRequest): Promise<HqBetResponse> {
        try {
            this.logger.log(`Placing bet via HQ service: ${this.config.hqServiceUrl}/api/transactions/bet`);

            const response: AxiosResponse<HqBetResponse> = await this.getClient().post(
                `${this.config.hqServiceUrl}/api/transactions/bet`,
                request,
                {
                    timeout: this.config.hqServiceTimeout,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            );

            // this.logger.debug(`HQ bet response: ${JSON.stringify(response.data)}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to place bet via HQ service: ${error.message}`);
            this.handleError(error);
        }
    }

    async creditWin(request: HqCreditRequest): Promise<HqCreditResponse> {
        try {
            this.logger.log(`Crediting win via HQ service: ${this.config.hqServiceUrl}/api/transactions/credit`);

            const response: AxiosResponse<HqCreditResponse> = await this.getClient().post(
                `${this.config.hqServiceUrl}/api/transactions/credit`,
                request,
                {
                    timeout: this.config.hqServiceTimeout,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            );

            // this.logger.debug(`HQ credit response: ${JSON.stringify(response.data)}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to credit win via HQ service: ${error.message}`);
            this.handleError(error);
        }
    }

    private getClient(): AxiosInstance {
        if (this.client) return this.client;
        const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 200 });
        const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 200 });
        this.client = axios.create({
            httpAgent: keepAliveHttp,
            httpsAgent: keepAliveHttps,
            headers: { 'Content-Type': 'application/json' },
        });
        return this.client;
    }

    private handleError(error: any): never {
        if (axios.isAxiosError(error)) {
            if (error.response) {
                const errorData = error.response.data;
                throw new Error(errorData.message || errorData.error || 'Unknown error');
            } else if (error.request) {
                throw new Error('Service is unavailable - no response received');
            }
        }
        throw new Error(`Failed to communicate: ${error.message}`);
    }
}
