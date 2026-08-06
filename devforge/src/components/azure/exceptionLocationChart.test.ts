import { describe, it, expect } from 'vitest';
import { siteLabel, siteKey } from './exceptionLocationChart';
import type { ExceptionLocationSeries } from '@shared/types/azureMetrics.types';

const site = (over: Partial<ExceptionLocationSeries>): ExceptionLocationSeries => ({
  bucket: 'generic', assembly: '', method: '', file: '',
  trueCount: 1, series: [], ...over,
});

describe('siteLabel', () => {
  it('prefers the file, and never carries a line number', () => {
    expect(siteLabel(site({
      file: '/src/src/MIMS.Specialty.App/MIMS.Specialty.App.Client/Pages/Common/CopyProtectionWidget.razor',
      method: 'MIMS.Specialty.App.Client.Pages.Common.CopyProtectionWidget+<OnInitializedAsync>d__4.MoveNext',
    }))).toBe('CopyProtectionWidget.razor');
  });

  it('handles Windows-style separators', () => {
    expect(siteLabel(site({ file: 'D:\\a\\_work\\src\\Foo.cs' }))).toBe('Foo.cs');
  });

  // App Insights ships no file info for release builds without PDBs, which is the
  // common case for the API — the method has to carry the label on its own.
  it('falls back to the method, unwrapping the async state machine', () => {
    expect(siteLabel(site({
      method: 'MIMS.Specialty.App.Client.Pages.Common.CopyProtectionWidget+<OnInitializedAsync>d__4.MoveNext',
    }))).toBe('CopyProtectionWidget.OnInitializedAsync');
  });

  it('shortens a plain qualified method to type.method', () => {
    expect(siteLabel(site({ method: 'MIMS.Specialty.Api.Controllers.DrugController.Get' })))
      .toBe('DrugController.Get');
  });

  it('leaves an already-short method alone', () => {
    expect(siteLabel(site({ method: 'MoveNext' }))).toBe('MoveNext');
  });

  it('falls back to the assembly, then to a placeholder', () => {
    expect(siteLabel(site({ assembly: 'MIMS.Specialty.App' }))).toBe('MIMS.Specialty.App');
    expect(siteLabel(site({}))).toBe('(unknown site)');
  });
});

describe('siteKey', () => {
  const asm = 'MIMS.Specialty.App.Client';
  const file = '/src/src/MIMS.Specialty.App/MIMS.Specialty.App.Client/Pages/Common/CopyProtectionWidget.razor';

  // The bug this guards: two lifecycle hooks in one .razor drew two legend rows
  // with the identical label, each holding half the count.
  it('merges two methods in the same file into one site', () => {
    expect(siteKey(site({ assembly: asm, file, method: 'Widget+<OnInitializedAsync>d__4.MoveNext' })))
      .toBe(siteKey(site({ assembly: asm, file, method: 'Widget+<OnAfterRenderAsync>d__7.MoveNext' })));
  });

  it('keeps same-named files in different assemblies apart', () => {
    expect(siteKey(site({ assembly: 'A', file: '/x/Foo.cs' })))
      .not.toBe(siteKey(site({ assembly: 'B', file: '/y/Foo.cs' })));
  });

  it('falls back to the method when the frame has no file', () => {
    expect(siteKey(site({ assembly: asm, method: 'M1' })))
      .not.toBe(siteKey(site({ assembly: asm, method: 'M2' })));
  });
});
