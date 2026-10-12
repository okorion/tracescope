use serde::Serialize;

#[derive(Debug, Copy, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct Handle {
    pub index: u32,
    pub generation: u32,
}

pub struct Slot<T> {
    pub generation: u32,
    pub marked: bool,
    pub value: Option<T>,
    pub retired: bool,
    pub last_reclaimed_collection: Option<u64>,
}

/// Handles contain indices, never addresses. Vec growth cannot invalidate them.
/// A slot at generation u32::MAX is permanently retired on removal, never wrapped.
pub struct Arena<T> {
    pub slots: Vec<Slot<T>>,
    free_list: Vec<u32>,
    pub allocations: u64,
    pub reused: u64,
    pub active: usize,
    pub retired: usize,
}

impl<T> Default for Arena<T> {
    fn default() -> Self {
        Self {
            slots: Vec::new(),
            free_list: Vec::new(),
            allocations: 0,
            reused: 0,
            active: 0,
            retired: 0,
        }
    }
}

impl<T> Arena<T> {
    pub fn insert(&mut self, value: T) -> Handle {
        self.allocations += 1;
        self.active += 1;
        if let Some(index) = self.free_list.pop() {
            let slot = &mut self.slots[index as usize];
            debug_assert!(slot.value.is_none() && !slot.retired && slot.generation < u32::MAX);
            slot.generation += 1;
            slot.marked = false;
            slot.value = Some(value);
            self.reused += 1;
            Handle {
                index,
                generation: slot.generation,
            }
        } else {
            let index =
                u32::try_from(self.slots.len()).expect("engine span limit is below u32::MAX");
            self.slots.push(Slot {
                generation: 1,
                marked: false,
                value: Some(value),
                retired: false,
                last_reclaimed_collection: None,
            });
            Handle {
                index,
                generation: 1,
            }
        }
    }

    pub fn get(&self, handle: Handle) -> Option<&T> {
        self.slots
            .get(handle.index as usize)
            .filter(|slot| slot.generation == handle.generation)?
            .value
            .as_ref()
    }

    pub fn get_mut(&mut self, handle: Handle) -> Option<&mut T> {
        self.slots
            .get_mut(handle.index as usize)
            .filter(|slot| slot.generation == handle.generation)?
            .value
            .as_mut()
    }

    pub fn remove(&mut self, handle: Handle, collection: u64) -> Option<T> {
        let slot = self.slots.get_mut(handle.index as usize)?;
        if slot.generation != handle.generation {
            return None;
        }
        let value = slot.value.take()?;
        slot.marked = false;
        slot.last_reclaimed_collection = Some(collection);
        self.active -= 1;
        if slot.generation == u32::MAX {
            slot.retired = true;
            self.retired += 1;
        } else {
            self.free_list.push(handle.index);
        }
        Some(value)
    }

    pub fn free_count(&self) -> usize {
        self.free_list.len()
    }

    /// Returns true exactly once per collection for each currently valid handle.
    pub fn mark(&mut self, handle: Handle) -> bool {
        let Some(slot) = self.slots.get_mut(handle.index as usize) else {
            return false;
        };
        if slot.generation != handle.generation || slot.value.is_none() || slot.marked {
            return false;
        }
        slot.marked = true;
        true
    }

    pub fn clear_marks(&mut self) {
        for slot in &mut self.slots {
            slot.marked = false;
        }
    }

    pub fn sweep(&mut self, collection: u64) -> usize {
        let mut reclaimed = 0;
        for index in 0..self.slots.len() {
            let slot = &self.slots[index];
            if slot.value.is_some() && !slot.marked {
                let handle = Handle {
                    index: index as u32,
                    generation: slot.generation,
                };
                self.remove(handle, collection);
                reclaimed += 1;
            }
        }
        reclaimed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allocate_reclaim_reuse_and_reject_stale() {
        let mut arena = Arena::default();
        let old = arena.insert("first");
        assert_eq!(
            old,
            Handle {
                index: 0,
                generation: 1
            }
        );
        assert_eq!(arena.get(old), Some(&"first"));
        assert_eq!(arena.remove(old, 1), Some("first"));
        assert_eq!(arena.remove(old, 1), None);
        assert_eq!(arena.free_count(), 1);
        let new = arena.insert("second");
        assert_eq!(new.index, old.index);
        assert_eq!(new.generation, 2);
        assert!(arena.get(old).is_none());
        assert!(arena.remove(old, 2).is_none());
        assert_eq!(arena.get(new), Some(&"second"));
        assert_eq!(arena.active, 1);
        assert_eq!(arena.reused, 1);
        assert_eq!(arena.free_count(), 0);
    }
    #[test]
    fn bounds_and_vec_growth_are_safe() {
        let mut arena = Arena::default();
        let first = arena.insert(7);
        for i in 0..10000 {
            arena.insert(i);
        }
        assert_eq!(arena.get(first), Some(&7));
        let invalid = Handle {
            index: u32::MAX,
            generation: 1,
        };
        assert!(arena.get(invalid).is_none());
        assert!(arena.remove(invalid, 1).is_none());
        assert!(!arena.mark(invalid));
    }
    #[test]
    fn generation_overflow_retires_slot() {
        let mut arena = Arena::default();
        let h = arena.insert(1);
        arena.slots[h.index as usize].generation = u32::MAX - 1;
        arena.remove(
            Handle {
                generation: u32::MAX - 1,
                ..h
            },
            1,
        );
        let last = arena.insert(2);
        assert_eq!(last.generation, u32::MAX);
        arena.remove(last, 2);
        assert_eq!(arena.retired, 1);
        assert_eq!(arena.free_count(), 0);
        let next = arena.insert(3);
        assert_ne!(next.index, last.index);
        assert!(arena.get(last).is_none());
    }
}
