import { registerLocaleData } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import ru from '@angular/common/locales/ru';
import { ApplicationConfig, LOCALE_ID } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideNzI18n, ru_RU } from 'ng-zorro-antd/i18n';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { provideNzNativeDateAdapter } from 'ng-zorro-antd/core/time';
import { ArrowDownOutline, ArrowUpOutline, BellOutline, CalendarOutline, CheckOutline, ClockCircleOutline, CloseOutline, CopyOutline, DownloadOutline, DownOutline, ExclamationCircleOutline, FileTextOutline, InfoCircleOutline, LeftOutline, LoadingOutline, MoonOutline, PlusOutline, RightOutline, SearchOutline, SyncOutline } from '@ant-design/icons-angular/icons';

registerLocaleData(ru);

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(),
    provideRouter([]),
    { provide: LOCALE_ID, useValue: 'ru' },
    provideNzI18n(ru_RU),
    provideNzNativeDateAdapter({ locale: 'ru-RU', firstDayOfWeek: 1 }),
    provideNzIcons([ArrowDownOutline, ArrowUpOutline, BellOutline, CalendarOutline, CheckOutline, ClockCircleOutline, CloseOutline, CopyOutline, DownloadOutline, DownOutline, ExclamationCircleOutline, FileTextOutline, InfoCircleOutline, LeftOutline, LoadingOutline, MoonOutline, PlusOutline, RightOutline, SearchOutline, SyncOutline]),
  ],
};
