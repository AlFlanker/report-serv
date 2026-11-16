import { Component, computed, input } from '@angular/core';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { JobStatus } from './models';
const statuses = {
  queued: { label: 'В очереди', icon: 'clock-circle' },
  running: { label: 'Выполняется', icon: 'sync' },
  completed: { label: 'Завершено', icon: 'check' },
  failed: { label: 'Ошибка', icon: 'exclamation-circle' },
};
@Component({
  selector: 'app-status-badge', imports: [NzIconModule, NzTagModule],
  template: `<nz-tag [class]="'status-badge status-' + status()"><nz-icon [nzType]="view().icon" /> {{ view().label }}</nz-tag>`,
})
export class StatusBadgeComponent {
  readonly status = input.required<JobStatus>();
  readonly view = computed(() => statuses[this.status()]);
}
