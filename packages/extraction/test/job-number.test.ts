import { describe, expect, it } from 'vitest';
import {
  canonicalJobNumber,
  compareJobNumbers,
  findJobNumbers,
  normalizeJobNumber,
} from '../src/job-number';
import { toStored, type ExtractedEvent } from '../src/schema';

describe('canonical form', () => {
  it('joins base and sub-job with a dot', () => {
    expect(canonicalJobNumber('2269', '2')).toBe('2269.2');
    expect(canonicalJobNumber('2269')).toBe('2269');
    expect(canonicalJobNumber('2269', null)).toBe('2269');
  });

  it('strips leading zeros from the sub-job', () => {
    expect(canonicalJobNumber('2269', '02')).toBe('2269.2');
    expect(canonicalJobNumber('2269', '002')).toBe('2269.2');
  });

  it('keeps a zero sub-job from collapsing into nothing sensible', () => {
    expect(canonicalJobNumber('2269', '0')).toBe('2269.0');
  });
});

describe('normalizeJobNumber — every variant lands on one canonical value', () => {
  const variants = [
    '2269.2',
    '2269-2',
    '2269_2',
    '2269 . 2',
    '#2269.2',
    '# 2269-2',
    'Job 2269.2',
    'job#2269-2',
    'JOB 2269_2',
    'project 2269.2',
    'Project #2269.2',
    'No. 2269.2',
    '2269.02',
    '  2269.2  ',
  ];

  for (const v of variants) {
    it(`normalizes ${JSON.stringify(v)} to 2269.2`, () => {
      expect(normalizeJobNumber(v)).toBe('2269.2');
    });
  }

  it('normalizes a bare base with no sub-job', () => {
    expect(normalizeJobNumber('2269')).toBe('2269');
    expect(normalizeJobNumber('job 2269')).toBe('2269');
  });

  it('returns null for values that hold no job number', () => {
    for (const v of [null, undefined, '', '   ', 'n/a', 'unknown', 'TBD', 'the lobby']) {
      expect(normalizeJobNumber(v)).toBeNull();
    }
  });

  it('extracts a job number embedded in a longer string', () => {
    expect(normalizeJobNumber('GVR Local Stone (job 2269.2)')).toBe('2269.2');
  });
});

describe('findJobNumbers — confidence levels', () => {
  it('treats an explicitly marked number as unambiguous', () => {
    const found = findJobNumbers('quote for job 2269.2 attached');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ value: '2269.2', confidence: 'marked' });
  });

  it('accepts 3-6 digits when marked', () => {
    expect(findJobNumbers('project 123')[0]).toMatchObject({ value: '123', confidence: 'marked' });
    expect(findJobNumbers('#123456')[0]).toMatchObject({ value: '123456', confidence: 'marked' });
  });

  it('treats a bare number as ambiguous and restricts it to 4 digits', () => {
    expect(findJobNumbers('2269.2 pricing')[0]).toMatchObject({
      value: '2269.2',
      confidence: 'bare',
    });
    // 3 and 6 digit bare numbers are not job-number shaped.
    expect(findJobNumbers('cost was 450')).toHaveLength(0);
    expect(findJobNumbers('order 123456 shipped').every((m) => m.confidence === 'marked')).toBe(
      true,
    );
  });

  it('does not double-count a marked number as also bare', () => {
    const found = findJobNumbers('job 2269.2');
    expect(found).toHaveLength(1);
  });

  it('finds several distinct job numbers in one message', () => {
    const found = findJobNumbers('2269.2 and 3310 both ship Tuesday');
    expect(found.map((m) => m.value)).toEqual(['2269.2', '3310']);
  });

  it('reports positions in source order for proximity checks', () => {
    const text = 'first 1180 then later 2269.2';
    const found = findJobNumbers(text);
    expect(found[0]!.index).toBeLessThan(found[1]!.index);
  });

  it('does not match inside a longer alphanumeric token', () => {
    // Container and tracking numbers must not read as job numbers.
    expect(findJobNumbers('MSCU1234567')).toHaveLength(0);
    expect(findJobNumbers('AAMkAGI2THVS2269')).toHaveLength(0);
  });

  it('does not match a decimal amount as a sub-job', () => {
    // "$1,450.00" — the fractional part is money, not a sub-job.
    expect(findJobNumbers('total 1450.00 usd').map((m) => m.value)).toEqual(['1450.0']);
  });

  it('returns nothing for empty input', () => {
    expect(findJobNumbers('')).toEqual([]);
  });
});

describe('storage normalization', () => {
  function ev(job: string | null): ExtractedEvent {
    return {
      ref: '1',
      job_number: job,
      project_name: 'GVR Local Stone',
      counterparty: null,
      counterparty_type: 'supplier',
      category: 'pricing',
      summary: 'x',
      action_required: false,
      action_owner: 'none',
      blocking_question: null,
      urgency: 'normal',
      dates_mentioned: [],
      amounts_mentioned: [],
      vessel_or_container: null,
    };
  }

  it('canonicalizes whatever the model returned', () => {
    expect(toStored(ev('2269-2'), 'x').job_number).toBe('2269.2');
    expect(toStored(ev('Job 2269.02'), 'x').job_number).toBe('2269.2');
    expect(toStored(ev('2269.2'), 'x').job_number).toBe('2269.2');
  });

  it('drops a value that is not job-number shaped', () => {
    expect(toStored(ev('unknown'), 'x').job_number).toBeNull();
    expect(toStored(ev(null), 'x').job_number).toBeNull();
  });
});

describe('ordering', () => {
  it('sorts numerically rather than lexically', () => {
    const sorted = ['3310', '12345', '1180', '2269.10', '2269.2'].sort(compareJobNumbers);
    expect(sorted).toEqual(['1180', '2269.2', '2269.10', '3310', '12345']);
  });
});
