import { TestBed } from '@angular/core/testing';

import { Location } from './location.service';

describe('Location', () => {
  let service: Location;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Location);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
