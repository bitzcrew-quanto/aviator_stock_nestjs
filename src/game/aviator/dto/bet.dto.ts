import { IsNumber, IsEnum, Min, Max, IsOptional } from 'class-validator';

export enum AviatorSide {
    LEFT = 'LEFT',
    RIGHT = 'RIGHT'
}

export class AviatorPlaceBetDto {
    @IsNumber()
    @Min(0.1, { message: 'Minimum bet is 0.1' })
    @Max(10000, { message: 'Maximum bet is 10000' })
    amount: number;

    @IsEnum(AviatorSide)
    side: AviatorSide;

    @IsOptional()
    @IsNumber()
    @Min(1.01, { message: 'Auto Cashout must be at least 1.01x' })
    autoCashOut?: number;
}

export class AviatorActionDto {
    @IsEnum(AviatorSide)
    side: AviatorSide;
}