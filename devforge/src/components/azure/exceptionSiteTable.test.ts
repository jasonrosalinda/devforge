import { describe, it, expect } from 'vitest';
import { formatLines, endpointLabel, stackLabel } from './exceptionSiteTable';

describe('formatLines', () => {
  it('concatenates the lines a site threw from', () => {
    expect(formatLines([24, 54])).toBe('24, 54');
  });

  it('sorts ascending regardless of arrival order', () => {
    expect(formatLines([54, 24, 9])).toBe('9, 24, 54');
  });

  // 0 is the sentinel the KQL frame expression uses for "no line info" — showing
  // it would claim the exception came from line zero.
  it('drops the no-line sentinel', () => {
    expect(formatLines([0])).toBe('');
    expect(formatLines([0, 24])).toBe('24');
  });

  it('is blank when there are no lines at all', () => {
    expect(formatLines([])).toBe('');
  });
});

describe('endpointLabel', () => {
  it('names the endpoint when it is the only one', () => {
    expect(endpointLabel({ endpoints: 1, sampleEndpoint: 'GET /singapore/disease/osteoarthritis/disease-summary' }))
      .toBe('GET /singapore/disease/osteoarthritis/disease-summary');
  });

  it('counts them when there is more than one', () => {
    expect(endpointLabel({ endpoints: 312, sampleEndpoint: 'GET /a' })).toBe('312 endpoints');
  });

  it('is blank when no endpoint was recorded', () => {
    expect(endpointLabel({ endpoints: 0, sampleEndpoint: '' })).toBe('');
  });
});

describe('stackLabel', () => {
  it('reads as a stack frame does', () => {
    expect(stackLabel({
      assembly: 'MIMS.Specialty.App.Client',
      method: 'MIMS.Specialty.App.Client.Pages.Common.CopyProtectionWidget+<OnInitializedAsync>d__4.MoveNext',
      file: '/src/src/MIMS.Specialty.App/MIMS.Specialty.App.Client/Pages/Common/CopyProtectionWidget.razor',
    })).toBe(
      'MIMS.Specialty.App.Client.Pages.Common.CopyProtectionWidget+<OnInitializedAsync>d__4.MoveNext'
      + ' @ /src/src/MIMS.Specialty.App/MIMS.Specialty.App.Client/Pages/Common/CopyProtectionWidget.razor',
    );
  });

  it('falls back through method, file, then assembly', () => {
    expect(stackLabel({ assembly: 'A', method: 'M', file: '' })).toBe('M');
    expect(stackLabel({ assembly: 'A', method: '', file: '/f.cs' })).toBe('/f.cs');
    expect(stackLabel({ assembly: 'A', method: '', file: '' })).toBe('A');
    expect(stackLabel({ assembly: '', method: '', file: '' })).toBe('(unknown site)');
  });
});
